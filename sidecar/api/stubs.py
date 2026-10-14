"""文件职责：M0 尚未实现的路由的 501 桩（契约先存在、实现后补，CODE_STYLE §1.8）。

依赖方向：api -> contracts；不碰 services。
谁调用：sidecar/api/router.py 构建路由时调用 build_stub_router()。

约定：桩函数一律 response_model=None——它们只会抛异常，FastAPI 不该去猜返回模型
（否则 NoReturn 会被当成响应类型并报 FastAPIError）。
"""

from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException

from contracts.errors import CODE_NOT_IMPLEMENTED, ErrorEnvelope

# 501 的错误信封写进 OpenAPI，前端据此写错误处理（CODE_STYLE §6.4：错误码只在边界层出现）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {501: {"model": ErrorEnvelope}}


def _not_implemented(method: str, path: str) -> HTTPException:
    """统一的 501 信封：message 给日志、user_hint 留给用户文案（M0 无需打扰用户）。"""
    return HTTPException(
        status_code=501,
        detail=ErrorEnvelope(
            code=CODE_NOT_IMPLEMENTED,
            message=f"{method} {path} 尚未实现（M0 只实现 GET /health）",
            user_hint=None,
        ).model_dump(mode="json"),
    )


def build_stub_router() -> APIRouter:
    """把 M0 未实现的路由挂成 501 桩；每个桩都写明它在哪个里程碑实现。"""
    router = APIRouter(tags=["stub"])

    @router.post(
        "/asr",
        summary="原始 PCM（不依赖 ffmpeg）→ 文本 + 置信度",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def asr_stub() -> NoReturn:
        """M0 桩：ASR 在 M1 实现（需求 §6.3）。"""
        raise _not_implemented("POST", "/asr")

    @router.post(
        "/tts",
        summary="文本 + 情感向量 → 音频流",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def tts_stub() -> NoReturn:
        """M0 桩：TTS 在 M1 实现（需求 §6.3）。"""
        raise _not_implemented("POST", "/tts")

    @router.post(
        "/tts/cancel",
        summary="按 request_id 取消未完成的合成",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def tts_cancel_stub() -> NoReturn:
        """M0 桩：打断能力在 M1 实现（需求 §5 F2）。"""
        raise _not_implemented("POST", "/tts/cancel")

    @router.post(
        "/chat/stream",
        summary="会话主入口：SSE 返回 LLM 事件流",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def chat_stream_stub() -> NoReturn:
        """M0 桩：LLM 事件流在 M1 实现（需求 §6.2）。"""
        raise _not_implemented("POST", "/chat/stream")

    @router.get(
        "/memory/search",
        summary="记忆检索：全文 + 重要度 + 时间衰减",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_search_stub() -> NoReturn:
        """M0 桩：记忆检索在 M2 实现（需求 §6.4）。"""
        raise _not_implemented("GET", "/memory/search")

    @router.post(
        "/memory/write",
        summary="写入记忆（带去重）",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_write_stub() -> NoReturn:
        """M0 桩：记忆写入在 M2 实现（需求 §6.4）。"""
        raise _not_implemented("POST", "/memory/write")

    @router.delete(
        "/memory/{memory_id}",
        summary="单条删除（隐私：让用户能要求忘掉某件事）",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_delete_stub(memory_id: str) -> NoReturn:
        """M0 桩：单条删除在 M2 实现（需求 §5 F3 的隐私要求）。"""
        raise _not_implemented("DELETE", f"/memory/{memory_id}")

    @router.post(
        "/screen/capture",
        summary="热键触发截屏 + OCR，返回文本且不落盘",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def screen_capture_stub() -> NoReturn:
        """M0 桩：屏幕识别在 M4 实现（需求 §5 F7）。"""
        raise _not_implemented("POST", "/screen/capture")

    @router.post(
        "/persona/import",
        summary="导入自有角色包（目录或单个 .zip）→ 体检 + 落地 characters/",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def persona_import_stub() -> NoReturn:
        """M0 桩：角色包导入在 M2 实现（需求 §5 F6）。"""
        raise _not_implemented("POST", "/persona/import")

    @router.post(
        "/gpu/lock",
        summary="重型推理串行排队（当前仅 TTS）",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def gpu_lock_stub() -> NoReturn:
        """M0 桩：推理资源闸门在 M1 实现（需求 §4.4）。"""
        raise _not_implemented("POST", "/gpu/lock")

    return router
