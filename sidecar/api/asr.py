"""文件职责：POST /asr 路由（原始 PCM 请求体 → 文本 + 置信度；需求 §6.3 / §5 F2）。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_asr_router()。
约定：
- 请求体是二进制 PCM，不是 JSON——所以用 openapi_extra 显式声明二进制请求体（§6.3）。
- 请求体大小有上限：超过上限的录音一定不是「一句话」，直接给 DP-ASR-005 而不是硬读进内存。
- 这里不吞异常：AsrError 交给 api/error_handlers.py 统一翻译成失败信封（CODE_STYLE §6.4）。
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request

from contracts.api_models import AsrQuery, AsrResponse
from contracts.errors import CODE_ASR_BAD_AUDIO, ErrorEnvelope
from contracts.routes import PCM_MEDIA_TYPE
from core.errors import AsrError
from services.asr_service import AsrService
from services.voice_service import VoiceService

#: 请求体上限 4 MiB ≈ 16kHz 单声道 int16 约 131 秒：远超「一句话」，超出即客户端出错
MAX_ASR_BODY_BYTES = 4 * 1024 * 1024

#: 可能的失败信封写进 OpenAPI，前端据此写错误处理
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}

#: /asr 的请求体是原始 PCM——用 openapi_extra 显式声明二进制请求体（需求 §6.3）
_ASR_REQUEST_BODY: dict[str, Any] = {
    "required": True,
    "content": {PCM_MEDIA_TYPE: {"schema": {"type": "string", "format": "binary"}}},
}


def build_asr_router(service: AsrService, voice: VoiceService) -> APIRouter:
    """把 /asr 挂成真实现；桩在 api/stubs.py 里对应删除。

    voice 把「ASR 在跑」登记进语音状态机：任何异常都走 activity() 的 finally，状态不会
    卡在 thinking（§6.7）。
    """
    router = APIRouter(tags=["asr"])

    @router.post(
        "/asr",
        summary="原始 PCM（不依赖 ffmpeg）→ 文本 + 置信度",
        response_model=AsrResponse,
        responses=_ERROR_RESPONSES,
        openapi_extra={"requestBody": _ASR_REQUEST_BODY},
    )
    async def asr(
        query: Annotated[AsrQuery, Query()],
        request: Request,
    ) -> AsrResponse:
        """识别一段录音；空 / 幻听结果以 text="" 返回，不当作错误（需求 §6.7）。"""
        payload = await request.body()
        if len(payload) > MAX_ASR_BODY_BYTES:
            raise AsrError(
                CODE_ASR_BAD_AUDIO,
                f"PCM 请求体过大：{len(payload)} 字节",
                user_hint="这段录音太长了，请分段发送。",
                context={"bytes": len(payload), "limit": MAX_ASR_BODY_BYTES},
            )
        async with voice.activity("asr"):
            return await service.transcribe(query, payload)

    return router
