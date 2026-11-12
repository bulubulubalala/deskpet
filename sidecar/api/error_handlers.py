"""文件职责：把内部异常翻译成 HTTP 失败信封，并写一条带 code / domain / trace 的日志。

依赖方向：api -> core（异常类型、日志纯逻辑）+ contracts（错误码与信封）；不碰 adapters。
谁调用：sidecar/app.py 的 create_app()。
约定：trace 只进日志，绝不进响应体（CODE_STYLE §6）。
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from contracts.errors import CODE_INTERNAL, ErrorDomain, ErrorEnvelope
from core.errors import DeskpetError
from core.logging import format_trace, get_logger, log_event

LOGGER = get_logger("api.error_handlers")
DESKPET_ERROR_STATUS = 500


def _dump(envelope: ErrorEnvelope) -> dict[str, object]:
    return envelope.model_dump(mode="json")


async def handle_deskpet_error(request: Request, exc: Exception) -> JSONResponse:
    """已知失败：回异常自带的 code / user_hint，完整栈只进日志。

    签名收 Exception 而不是 DeskpetError：Starlette 的处理器类型要求如此，
    注册时按 DeskpetError 精确匹配，非 DeskpetError 属防御性分支。
    """
    if not isinstance(exc, DeskpetError):
        return await handle_unexpected_error(request, exc)
    log_event(
        LOGGER,
        logging.ERROR,
        module="api.error_handlers",
        event="deskpet_error",
        message=exc.message,
        code=exc.code,
        domain=str(exc.domain),
        trace=format_trace(exc),
        fields={"method": request.method, "path": request.url.path, **exc.context},
    )
    return JSONResponse(status_code=DESKPET_ERROR_STATUS, content=_dump(exc.to_envelope()))


async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    """未知失败：对外只说「内部错误」，细节（含异常消息）只进日志，避免外泄内部信息。"""
    log_event(
        LOGGER,
        logging.ERROR,
        module="api.error_handlers",
        event="unhandled_error",
        message=type(exc).__name__,
        code=CODE_INTERNAL,
        domain=str(ErrorDomain.SYS),
        trace=format_trace(exc),
        fields={"method": request.method, "path": request.url.path},
    )
    envelope = ErrorEnvelope(code=CODE_INTERNAL, message="sidecar 内部错误")
    return JSONResponse(status_code=500, content=_dump(envelope))


def register_error_handlers(app: FastAPI) -> None:
    """在组合根挂上统一异常处理器；按异常类型精确匹配，与中间件顺序无关。"""
    app.add_exception_handler(DeskpetError, handle_deskpet_error)
    app.add_exception_handler(Exception, handle_unexpected_error)
