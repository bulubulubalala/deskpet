"""文件职责：把 §6.2 的事件对象序列化成 SSE 帧（EventSource 协议）。

依赖方向：core -> contracts；不 import adapters / api。
谁调用：api/chat.py 把 ChatService 的事件流转成 HTTP 响应体。

SSE 帧格式很窄：每个 data 段以 "data: " 开头、以空行结束；JSON 里不允许出现裸换行，
这里再做一次兜底替换，避免一句脏文本把流切错帧。
"""

from __future__ import annotations

from contracts.events import LlmEvent


def format_sse_data(payload: str) -> str:
    """把一段负载包成 SSE 帧（多行负载用多行 data: 前缀，这里只做单行）。"""
    flat = payload.replace("\r", " ").replace("\n", " ")
    return "data: " + flat + "\n\n"


def event_to_sse(event: LlmEvent) -> str:
    """事件 → SSE 帧；exclude_none 让可选字段不出现在线上（前端按可选处理）。"""
    return format_sse_data(event.model_dump_json(exclude_none=True))
