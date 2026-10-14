"""文件职责：日志的纯逻辑部分——脱敏、异常栈格式化、结构化字段拼装、事件入口。

依赖方向：core；只依赖标准库 logging 接口，不碰文件、不装 handler（那些在 adapters/log_writer.py）。
谁调用：任何需要写结构化日志的地方（api / services / sidecar/main.py）。
为什么拆开：写文件与滚动是 I/O，属于 adapters；这里是纯函数，CI 上没有磁盘也能测。
字段约定见 CODE_STYLE §6.2：ts / level / logger / message + module / event + code / domain / trace。
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Mapping

ROOT_LOGGER_NAME = "deskpet"

#: 敏感字段名（CODE_STYLE §6）：值一律替换成 [已脱敏]，键名保留以便排查「字段有没有传」。
SENSITIVE_KEYS = frozenset(
    {
        # 凭据
        "api_key",
        "apikey",
        "authorization",
        "token",
        "password",
        # 提示词与对话正文（可能夹带记忆 / 屏幕内容）
        "prompt",
        "messages",
        "conversation",
        # 记忆正文
        "memory_text",
        "memory_body",
        # 屏幕 OCR 原文
        "ocr_text",
        "screen_text",
        # 参考音绝对路径
        "ref_audio_path",
        "reference_audio",
    }
)

REDACTED = "[已脱敏]"


def redact_fields(fields: Mapping[str, object] | None) -> dict[str, object]:
    """把敏感字段的值换成 [已脱敏]；None / 空映射返回空字典。"""
    if not fields:
        return {}
    return {key: REDACTED if key in SENSITIVE_KEYS else value for key, value in fields.items()}


def format_trace(exc: BaseException) -> str:
    """异常链的完整文本（只进日志，绝不进响应体）。"""
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()


def build_log_payload(
    *,
    module: str,
    event: str,
    code: str | None = None,
    domain: str | None = None,
    trace: str | None = None,
    fields: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """拼装一条日志的业务字段（不含 ts / level / message，那些由 formatter 补）。"""
    payload: dict[str, object] = {"module": module, "event": event}
    if code is not None:
        payload["code"] = code
    if domain is not None:
        payload["domain"] = domain
    if trace is not None:
        payload["trace"] = trace
    # 自定义字段不得覆盖上面的保留键（否则事件名会被业务参数悄悄改掉）
    reserved = set(payload)
    payload.update(
        {key: value for key, value in redact_fields(fields).items() if key not in reserved}
    )
    return payload


def get_logger(name: str) -> logging.Logger:
    """取 deskpet 这棵 logger 树上的子 logger（例如 "api.error_handlers"）。"""
    return logging.getLogger(ROOT_LOGGER_NAME + "." + name)


def log_event(
    logger: logging.Logger,
    level: int,
    *,
    module: str,
    event: str,
    message: str,
    code: str | None = None,
    domain: str | None = None,
    trace: str | None = None,
    fields: Mapping[str, object] | None = None,
) -> None:
    """写一条结构化日志：message 给人看，其余字段给机器查（CODE_STYLE §6）。"""
    payload = build_log_payload(
        module=module,
        event=event,
        code=code,
        domain=domain,
        trace=trace,
        fields=fields,
    )
    logger.log(level, message, extra={"dp": payload})
