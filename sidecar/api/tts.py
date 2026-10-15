"""文件职责：POST /tts 与 POST /tts/cancel 路由（需求 §6.3 / §6.12）。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_tts_router()。
约定：
- /tts 的 200 是**二进制音频**（audio/wav），不是 JSON；引擎侧性能数字走响应头
  （X-Deskpet-Gen-Ms / -Audio-Ms / -Rtf / -Voice），T1.7 与 MEASURED.md 从这里取数。
- 响应头必须是 latin-1 可编码的：voice / request_id 里出现非 ASCII（Windows 上的中文音色名）
  时按百分号编码，避免 Starlette 编码响应头直接炸。（表现为可解析但需要调用方 unquote。）
- 这里不吞异常：TtsError 交给 api/error_handlers.py 统一翻译成失败信封（CODE_STYLE §6.4）。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Response

from contracts.api_models import TtsCancelRequest, TtsCancelResponse, TtsRequest
from contracts.errors import ErrorEnvelope
from contracts.routes import TTS_MEDIA_TYPE
from services.tts_service import TtsService
from services.voice_service import VoiceService

#: 可能的失败信封写进 OpenAPI，前端据此写错误处理
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}


def _header_value(raw: str) -> str:
    """响应头安全化：非 ASCII 一律百分号编码（HTTP 头只允许 latin-1）。"""
    return raw if raw.isascii() else quote(raw, safe="")


def build_tts_router(service: TtsService, voice: VoiceService) -> APIRouter:
    """把 /tts 与 /tts/cancel 挂成真实现；桩在 api/stubs.py 里对应删除。"""
    router = APIRouter(tags=["tts"])

    @router.post(
        "/tts",
        summary="文本 + 情感向量 → 音频流",
        response_model=None,
        responses={
            **_ERROR_RESPONSES,
            200: {
                "description": "合成后的 wav（响应头带引擎侧性能数字）",
                "content": {TTS_MEDIA_TYPE: {}},
            },
        },
    )
    async def tts(payload: TtsRequest) -> Response:
        """合成一句；失败按 §6.7 明确报错，绝不假装在说话。"""
        async with voice.activity("tts"):
            audio = await service.synthesize(payload)
        return Response(
            content=audio.audio,
            media_type=TTS_MEDIA_TYPE,
            headers={
                "X-Deskpet-Request-Id": _header_value(audio.request_id),
                "X-Deskpet-Gen-Ms": str(audio.gen_ms),
                "X-Deskpet-Audio-Ms": str(audio.audio_ms),
                "X-Deskpet-Rtf": str(audio.rtf),
                "X-Deskpet-Voice": _header_value(audio.voice),
            },
        )

    @router.post(
        "/tts/cancel",
        summary="按 request_id 取消未完成的合成",
        response_model=TtsCancelResponse,
        responses=_ERROR_RESPONSES,
    )
    async def tts_cancel(payload: TtsCancelRequest) -> TtsCancelResponse:
        """取消语义见 §6.12；cancelled=False 表示这句已经结束（正常情况）。

        同时把「一次打断」登记进语音状态机：打断是全局语义（T1.6），不只针对这一条合成；
        在途活动退干净后状态自动落回 idle。
        """
        voice.interrupt("tts_cancel")
        return await service.cancel(payload.request_id)

    return router
