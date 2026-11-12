"""文件职责：把内部异常转成给用户看的 ErrorDetail（原文、状态码、响应体、端点）。

为什么要经过这一层：适配器抛出的是 DeskpetError，context 里的字段名各家不完全一样
（LLM 叫 url/model，TTS 叫 url/voice，ASR 叫 url/model）；界面契约只认一套字段。
这里集中做字段归一化、脱敏与截断，避免每个调用点各拼一遍、漏掉某处密钥。

依赖方向：core -> contracts / core.errors / core.redact；不 import adapters / api / services。
谁调用：services/chat/stream_runner.py、services/chat/service.py、services/voice_session.py。
"""

from __future__ import annotations

import json

from contracts.errors import ErrorDetail
from core.errors import DeskpetError
from core.redact import (
    MAX_ERROR_BODY_CHARS,
    MAX_ERROR_MESSAGE_CHARS,
    clip_text,
    redact_secrets,
    safe_endpoint,
)

#: 端点/模型/请求 id 这类短字段的上限；超长只会把弹窗撑坏。
SHORT_FIELD_CHARS = 200


def _status_of(raw: object) -> int | None:
    """只接受 100..599 的整数状态码；字符串 "500" 也认，其它一律当没有。"""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        value = int(raw.strip())
    else:
        return None
    return value if 100 <= value <= 599 else None


def _text_of(raw: object) -> str:
    """context 里的值可能是 str / dict / list；统一转成可读文本。"""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    try:
        return json.dumps(raw, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(raw)


def build_error_detail(
    error: DeskpetError,
    *,
    attempts: int = 0,
    endpoint: str = "",
    model: str = "",
) -> ErrorDetail:
    """从异常自带的 context 里捞出现场；缺什么就留空，不编造。"""
    context = error.context
    body_text = _text_of(context.get("body"))
    if body_text == "" and "error" in context:
        body_text = _text_of(context.get("error"))
    return ErrorDetail(
        message=clip_text(redact_secrets(error.message), MAX_ERROR_MESSAGE_CHARS),
        status=_status_of(context.get("status")),
        body=clip_text(redact_secrets(body_text), MAX_ERROR_BODY_CHARS),
        endpoint=safe_endpoint(_text_of(context.get("url")) or endpoint),
        model=clip_text(
            _text_of(context.get("model") or context.get("voice")) or model, SHORT_FIELD_CHARS
        ),
        request_id=clip_text(
            redact_secrets(_text_of(context.get("request_id"))), SHORT_FIELD_CHARS
        ),
        attempts=max(0, attempts),
    )


def detail_log_fields(detail: ErrorDetail) -> dict[str, object]:
    """给日志用的扁平字段；message 改名成 detail_message，避免覆盖日志本身的 message。"""
    return {
        "detail_message": detail.message,
        "status": detail.status,
        "body": detail.body,
        "endpoint": detail.endpoint,
        "model": detail.model,
        "request_id": detail.request_id,
        "attempts": detail.attempts,
    }


def manual_error_detail(
    message: str,
    *,
    status: int | None = None,
    body: str = "",
    endpoint: str = "",
    model: str = "",
    request_id: str = "",
    attempts: int = 0,
) -> ErrorDetail:
    """代码自己发现、没有异常的失败（例如未配置端点）也能带一份可复制的现场。"""
    return ErrorDetail(
        message=clip_text(redact_secrets(message), MAX_ERROR_MESSAGE_CHARS),
        status=_status_of(status),
        body=clip_text(redact_secrets(body), MAX_ERROR_BODY_CHARS),
        endpoint=safe_endpoint(endpoint),
        model=clip_text(redact_secrets(model), SHORT_FIELD_CHARS),
        request_id=clip_text(redact_secrets(request_id), SHORT_FIELD_CHARS),
        attempts=max(0, attempts),
    )


def detail_from_exception(
    exc: BaseException,
    *,
    attempts: int = 0,
    endpoint: str = "",
    model: str = "",
) -> ErrorDetail:
    """未预期异常的兜底：至少留下异常类型与消息，别让界面只剩一句「内部故障」。"""
    if isinstance(exc, DeskpetError):
        return build_error_detail(exc, attempts=attempts, endpoint=endpoint, model=model)
    return manual_error_detail(
        type(exc).__name__ + ": " + str(exc),
        endpoint=endpoint,
        model=model,
        attempts=attempts,
    )
