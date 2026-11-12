"""文件职责：原文与摘要：记一轮原文、翻原文、改/删原文，以及摘要的查看与纠错。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

from contracts.errors import (
    CODE_MEM_INDEX_BROKEN,
)
from core.errors import MemoryStoreError
from core.memory import (
    DEFAULT_MESSAGE_PAGE_LIMIT,
    HistoryRole,
    MemoryBackendError,
    MessageDraft,
    MessageRow,
    SummarySnippet,
    estimate_tokens,
)

from .base import MemoryServiceBase


class MessagesMixin(MemoryServiceBase):
    """原文与摘要：记一轮原文、翻原文、改/删原文，以及摘要的查看与纠错。"""

    def record_message(
        self, *, char_id: str, session_id: str, role: HistoryRole, text: str, ts: float
    ) -> None:
        """把一轮里的一条消息写进 L0（历史层）。失败只降级，不影响这轮对话。"""
        body = text.strip()
        if self._store is None or not body:
            return
        draft = MessageDraft(
            char_id=char_id,
            session_id=session_id,
            role=role,
            text=body,
            ts=ts,
            token_len=estimate_tokens(body),
        )
        try:
            self._store.add_messages([draft])
        except MemoryBackendError as exc:
            self._degrade(exc, action="record_message")

    def list_messages(
        self,
        char_id: str,
        *,
        limit: int = DEFAULT_MESSAGE_PAGE_LIMIT,
        before_id: int | None = None,
    ) -> list[MessageRow]:
        """按 id 倒序翻一个角色的历史原文（开发者模式「原文」页，T2.3-B1）。

        只读：原文是压缩链路的输入，改了会破坏 covered_by 的覆盖关系（方案 §3.3）。
        """
        store = self._require_store()
        try:
            return store.list_messages(char_id, limit=limit, before_id=before_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def edit_message(self, message_id: int, *, text: str) -> MessageRow | None:
        store = self._require_store()
        body = text.strip()
        if not body:
            raise MemoryStoreError(CODE_MEM_INDEX_BROKEN, "原文内容为空")
        try:
            return store.update_message(message_id, text=body)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def delete_message(self, message_id: int) -> bool:
        store = self._require_store()
        try:
            return store.delete_message(message_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def list_all_summaries(self, char_id: str, *, limit: int = 100) -> list[SummarySnippet]:
        store = self._require_store()
        try:
            return store.list_all_summaries(char_id, limit=limit)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def edit_summary(self, summary_id: int, *, text: str) -> SummarySnippet | None:
        store = self._require_store()
        body = text.strip()
        if not body:
            raise MemoryStoreError(CODE_MEM_INDEX_BROKEN, "摘要内容为空")
        try:
            return store.update_summary(summary_id, text=body)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def delete_summary(self, summary_id: int) -> bool:
        store = self._require_store()
        try:
            return store.delete_summary(summary_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc
