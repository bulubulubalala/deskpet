"""文件职责：尚未实现的路由的 501 桩（契约先存在、实现后补，CODE_STYLE §1.8）。

依赖方向：api -> contracts；不碰 services。
谁调用：sidecar/api/router.py 构建路由时调用 build_stub_router()。

约定：
- 桩函数只抛异常，所以要么显式 response_model=None，要么给出真实响应模型——绝不让 FastAPI
  去猜 NoReturn（会被当成响应类型并报 FastAPIError）。
- T1.1 起，§6.3 里 M1 要做的路由按 contracts/routes.py 的模型级契约挂上真实的 query /
  请求体 / 200 响应声明。这样 OpenAPI 快照里就有完整类型，前端不必等实现到位就能写界面。
- 已实现的路由必须从这里摘掉（T1.3 摘掉 /chat/stream → api/chat.py，T1.4 摘掉 /asr →
  api/asr.py）：
  桩与真实现同时存在会让 OpenAPI 出现重复路径，契约测试会红。
"""

from typing import Any, NoReturn

from fastapi import APIRouter, HTTPException

from contracts.api_models import (
    GpuLockRequest,
    GpuLockResponse,
    TtsCancelRequest,
    TtsCancelResponse,
    TtsRequest,
)
from contracts.errors import CODE_NOT_IMPLEMENTED, ErrorEnvelope
from contracts.routes import TTS_MEDIA_TYPE

# 501 的错误信封写进 OpenAPI，前端据此写错误处理（CODE_STYLE §6.4：错误码只在边界层出现）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {501: {"model": ErrorEnvelope}}


def _media_response(media_type: str, description: str) -> dict[str, Any]:
    """非 JSON 的 200 响应（音频流 / SSE）在 OpenAPI 里的声明。"""
    return {"description": description, "content": {media_type: {}}}


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
    """把未实现的路由挂成 501 桩；每个桩都写明它在哪个里程碑实现。

    新增实现时：先改 contracts/routes.py 的 implemented 标志，再把对应桩从这里删掉，
    最后在 api/ 下新增真实路由——契约测试会验证「声明已实现」与「不再有桩」一致。
    """
    router = APIRouter(tags=["stub"])

    @router.post(
        "/tts",
        summary="文本 + 情感向量 → 音频流",
        response_model=None,
        responses={
            **_ERROR_RESPONSES,
            200: _media_response(TTS_MEDIA_TYPE, "合成后的音频流（T1.5 实现）"),
        },
    )
    async def tts_stub(payload: TtsRequest) -> NoReturn:
        """M1 桩：合成在 T1.5 实现（需求 §6.3 / §6.12）；请求模型已声明。"""
        raise _not_implemented("POST", "/tts")

    @router.post(
        "/tts/cancel",
        summary="按 request_id 取消未完成的合成",
        response_model=TtsCancelResponse,
        responses=_ERROR_RESPONSES,
    )
    async def tts_cancel_stub(payload: TtsCancelRequest) -> TtsCancelResponse:
        """M1 桩：打断能力在 T1.5/T1.6 实现（需求 §5 F2 / §6.12 的取消语义）。"""
        raise _not_implemented("POST", "/tts/cancel")

    @router.get(
        "/memory/search",
        summary="记忆检索：全文 + 重要度 + 时间衰减",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_search_stub() -> NoReturn:
        """M2 桩：记忆检索在 M2 实现（需求 §6.4）。"""
        raise _not_implemented("GET", "/memory/search")

    @router.post(
        "/memory/write",
        summary="写入记忆（带去重）",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_write_stub() -> NoReturn:
        """M2 桩：记忆写入在 M2 实现（需求 §6.4）。"""
        raise _not_implemented("POST", "/memory/write")

    @router.delete(
        "/memory/{memory_id}",
        summary="单条删除（隐私：让用户能要求忘掉某件事）",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def memory_delete_stub(memory_id: str) -> NoReturn:
        """M2 桩：单条删除在 M2 实现（需求 §5 F3 的隐私要求）。"""
        raise _not_implemented("DELETE", f"/memory/{memory_id}")

    @router.post(
        "/screen/capture",
        summary="热键触发截屏 + OCR，返回文本且不落盘",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def screen_capture_stub() -> NoReturn:
        """M4 桩：屏幕识别在 M4 实现（需求 §5 F7）。"""
        raise _not_implemented("POST", "/screen/capture")

    @router.post(
        "/persona/import",
        summary="导入自有角色包（目录或单个 .zip）→ 体检 + 落地 characters/",
        response_model=None,
        responses=_ERROR_RESPONSES,
    )
    async def persona_import_stub() -> NoReturn:
        """M2 桩：角色包导入在 M2 实现（需求 §5 F6）。"""
        raise _not_implemented("POST", "/persona/import")

    @router.post(
        "/gpu/lock",
        summary="重型推理串行排队（当前仅 TTS）",
        response_model=GpuLockResponse,
        responses=_ERROR_RESPONSES,
    )
    async def gpu_lock_stub(payload: GpuLockRequest) -> GpuLockResponse:
        """M1 桩：推理资源闸门在 T1.8 实现（需求 §4.4）；模型已声明。"""
        raise _not_implemented("POST", "/gpu/lock")

    return router
