"""文件职责：把模型吐出来的**不可信文本**解析成事件（§6.2）。

为什么单独一层：模型的每一行输出都是外部数据——可能不是 JSON、可能是被截断的 JSON、
可能字段超长导致校验失败。这一层只回答「这一行能变成什么事件」，不关心 HTTP、重试、
记忆或统计；坏数据只会降级成「说人话」或整行丢弃，绝不把异常抛给上层。

依赖方向：services -> core / contracts；不 import adapters、api。
谁调用：services/chat/stream_runner.py 每收到一行就调 parse_line()。
"""

from __future__ import annotations

import json
import logging
import re

from pydantic import ValidationError

from contracts.events import LLM_EVENT_ADAPTER, LlmEvent, SentenceEvent
from core.logging import get_logger, log_event
from core.text import split_sentences

LOGGER = get_logger("sidecar.services.chat")

#: 整行 json.loads 失败时用的兜底：模型偶尔在闭合花括号前多写一个引号，
#: 但 text 字段本身是完整的。只取字符串值，绝不做解释或求值。
_TEXT_FIELD_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')


def loose_text(raw: str) -> str | None:
    """用正则从坏 JSON 里捞出 text 字段的字面量（捞不到返回 None）。"""
    match = _TEXT_FIELD_RE.search(raw)
    if match is None:
        return None
    try:
        value = json.loads('"' + match.group(1) + '"')
    except ValueError:
        return None
    stripped = value.strip()
    return stripped or None


def is_open_json(text: str) -> bool:
    """text 是否看起来是「一条还没闭合的 JSON 事件」（用于跨行拼回，§6.2）。"""
    stripped = text.strip()
    if not stripped.startswith("{"):
        return False
    depth = 0
    in_string = False
    escaped = False
    for char in stripped:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return False
    return True


def salvaged_text(raw: str) -> str | None:
    """从「整行是 JSON 但字段不合规」的报文里捞出还能当台词念的 text 字段。

    典型场景：模型给出的台词超过 40 字上限，事件校验失败。此时若把整行 JSON 原文
    当纯文本播报，用户会听到一串花括号；能捞出 text 就用它（§6.2 的降级是「说人话」）。
    整行连 JSON 都不是时走 _loose_text（真机见过「多一个引号」导致整行解析失败）。
    """
    try:
        payload = json.loads(raw)
    except ValueError:
        return loose_text(raw)
    if not isinstance(payload, dict):
        return loose_text(raw)
    value = payload.get("text")
    if isinstance(value, str) and value.strip():
        return value
    return loose_text(raw)


def parse_line(line: str, index: int, fallback_logged: bool) -> tuple[list[LlmEvent], int, bool]:
    """解析一行模型输出 → 事件列表 + 新的句子序号 + 是否已记过降级警告。

    合法 JSON 事件直接用（跨行的事件由 _stream_once 先拼回）；解析失败分两种降级：
    能捞出 text 字段就念它（§6.2「说人话」），捞不到就整行丢掉——真机上见过模型多写
    一个引号导致校验失败，而按纯文本播报会把花括号片段念给用户。警告只记一次。
    """
    stripped = line.strip()
    if not stripped:
        return [], index, fallback_logged

    reason: str | None = None
    text = stripped
    if stripped.startswith("{"):
        try:
            event = LLM_EVENT_ADAPTER.validate_json(stripped)
        except ValidationError as exc:
            first: dict[str, object] = dict(exc.errors()[0]) if exc.errors() else {}
            reason = str(first.get("type", "invalid"))
            salvaged = salvaged_text(stripped)
            if salvaged is None:
                log_fallback(len(stripped), reason, fallback_logged)
                return [], index, True
            text = salvaged
        else:
            if isinstance(event, SentenceEvent):
                return [event], max(index, event.i + 1), fallback_logged
            return [event], index, fallback_logged
    else:
        reason = "not_json"

    log_fallback(len(stripped), reason, fallback_logged)
    events: list[LlmEvent] = [
        SentenceEvent(text=piece, i=index + offset)
        for offset, piece in enumerate(split_sentences(text))
    ]
    return events, index + len(events), True


def log_fallback(chars: int, reason: str | None, already_logged: bool) -> None:
    """降级警告每轮只记一次，否则一行坏数据就能把日志刷满。"""
    if already_logged:
        return
    log_event(
        LOGGER,
        logging.WARNING,
        module="sidecar.services.chat",
        event="chat.plain_text_fallback",
        message="模型输出不是合法事件行，已降级处理",
        fields={"chars": chars, "reason": reason},
    )


__all__ = ["is_open_json", "log_fallback", "loose_text", "parse_line", "salvaged_text"]
