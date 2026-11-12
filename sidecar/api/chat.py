"""文件职责：POST /chat/stream 的 SSE 路由（薄层：协议转换、断连/打断处理、状态登记）。

依赖方向：api -> services（注入）/ core / contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_chat_router()。

为什么错误也必须走 SSE：响应头一旦发出就是 200，此后再抛异常只会变成「连接莫名中断」。
所以本层把任何失败都收敛成 §6.2 的 ErrorEvent + EndEvent——前端至少能明确告诉用户
「网络不通」，而不是让它对着一个静默死掉的流发呆（§6.7）。

语音状态（T1.6）：本轮生成用 voice.activity("chat") 包住，退出（正常 / 报错 / 断连）必定
注销活动，状态不会卡在 thinking；用户在别处打断（例如 /tts/cancel）会让 generation 作废，
这里在下一帧就停手——取消是一等公民。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from contracts.api_models import ChatStreamRequest
from contracts.errors import CODE_INTERNAL, ErrorEnvelope
from contracts.events import LLM_EVENT_KINDS, EndEvent, ErrorEvent
from contracts.routes import API_ROUTES, SSE_MEDIA_TYPE
from core.errors import DeskpetError
from core.logging import get_logger, log_event
from core.sse import event_to_sse
from services.chat_service import ChatService
from services.voice_service import VoiceService

LOGGER = get_logger("sidecar.api.chat")

_CHAT_ROUTE = next(route for route in API_ROUTES if route.path == "/chat/stream")

#: SSE 的 200 负载形状写进 OpenAPI：t 的枚举来自 contracts/events.py 的唯一定义处，
#: tests/test_api_contract.py 会与 app/main/ipc.ts 的 CHAT_EVENT_KINDS 对账。
_SSE_RESPONSE: dict[str, Any] = {
    "description": "SSE 流：每个 data 段是一个 §6.2 事件，单句 text ≤40 字",
    "content": {
        SSE_MEDIA_TYPE: {
            "schema": {
                "type": "object",
                "properties": {"t": {"type": "string", "enum": list(LLM_EVENT_KINDS)}},
                "required": ["t"],
            }
        }
    },
}

_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {500: {"model": ErrorEnvelope}}


async def _stream_sse(
    chat_service: ChatService,
    payload: ChatStreamRequest,
    request: Request,
    voice: VoiceService,
) -> AsyncIterator[str]:
    """把服务层事件流转成 SSE 帧；客户端断连或本机打断时立刻停止本轮。"""
    async with voice.activity("chat") as generation:
        try:
            async for event in chat_service.stream_events(payload):
                disconnected = await request.is_disconnected()
                interrupted = voice.is_cancelled(generation)
                if disconnected or interrupted:
                    log_event(
                        LOGGER,
                        logging.INFO,
                        module="sidecar.api.chat",
                        event="chat.cancelled",
                        message="本轮生成已取消",
                        fields={
                            "session_id": payload.session_id,
                            "reason": "voice_interrupted" if interrupted else "client_disconnected",
                        },
                    )
                    # 打断也是使用事实（§6.9 的 interrupt_count），交给统计层去重与批量写
                    chat_service.record_interrupt(payload.session_id)
                    return
                yield event_to_sse(event)
        except DeskpetError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="sidecar.api.chat",
                event="chat.error_event",
                message="会话流以错误事件收尾",
                code=exc.code,
                domain=exc.domain,
                trace=str(exc),
            )
            yield event_to_sse(
                ErrorEvent(
                    code=exc.code,
                    user_hint=exc.user_hint or "刚刚出了点问题，稍后再试",
                    recoverable=True,
                )
            )
            yield event_to_sse(EndEvent())
        except Exception as exc:  # 200 已发出，兜底必须转成事件（见模块 docstring）
            log_event(
                LOGGER,
                logging.ERROR,
                module="sidecar.api.chat",
                event="chat.unhandled",
                message="会话流出现未预期异常",
                code=CODE_INTERNAL,
                trace=type(exc).__name__ + ": " + str(exc),
            )
            yield event_to_sse(
                ErrorEvent(
                    code=CODE_INTERNAL, user_hint="出了点内部故障，稍后再试", recoverable=True
                )
            )
            yield event_to_sse(EndEvent())


def build_chat_router(chat_service: ChatService, voice: VoiceService) -> APIRouter:
    """挂载 /chat/stream（唯一会话入口，§6.3）。"""
    router = APIRouter()

    @router.post(
        _CHAT_ROUTE.path,
        summary=_CHAT_ROUTE.purpose,
        response_model=None,
        responses={**_ERROR_RESPONSES, 200: _SSE_RESPONSE},
    )
    async def chat_stream(payload: ChatStreamRequest, request: Request) -> StreamingResponse:
        """流式返回 LLM 事件（§6.2）；请求未配模型时第一个事件就是 ErrorEvent。"""
        return StreamingResponse(
            _stream_sse(chat_service, payload, request, voice),
            media_type=SSE_MEDIA_TYPE,
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
