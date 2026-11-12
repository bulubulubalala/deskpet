"""文件职责：记忆条目本身：写入、检索、列表、单删、编辑、清空、衰减与过期清理。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from contracts.errors import (
    CODE_MEM_INDEX_BROKEN,
)
from core.errors import MemoryStoreError
from core.memory import (
    ACTION_KIND,
    FactSnippet,
    MemoryBackendError,
    MemoryDraft,
    MemoryQuery,
    MemoryRecord,
    RecallQuery,
    rrf_merge_facts,
)
from services.recall_builder import RecallBuilder

from .base import MemoryServiceBase


class MemoriesMixin(MemoryServiceBase):
    """记忆条目本身：写入、检索、列表、单删、编辑、清空、衰减与过期清理。"""

    def remember(self, draft: MemoryDraft, *, now: float = 0.0) -> tuple[int, bool]:
        """手动写入一条记忆；返回 (memory_id, 是否已存在)。

        now=0 表示「用现在」——不传的话 created_at 会落成 0，记忆的排序与衰减就全错了。
        """
        store = self._require_store()
        body = draft.text.strip()
        if not body:
            raise MemoryStoreError(
                CODE_MEM_INDEX_BROKEN,
                "记忆内容为空",
                user_hint="要记住的内容不能是空的。",
            )
        moment = now if now > 0 else self._now()
        try:
            return store.upsert_memory(replace(draft, text=body), now=moment)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def search(
        self, query: RecallQuery, *, query_vector: Sequence[float] | None = None
    ) -> list[FactSnippet]:
        """按查询检索记忆（管理界面 / 调试用）；有 query_vector 时做 FTS+向量 RRF。"""
        store = self._require_store()
        effective = query if query.now > 0 else replace(query, now=self._now())
        try:
            fts = store.search_memories(effective)
            if not query_vector or not self._tuning.model:
                return fts
            try:
                hits = store.search_embeddings(
                    query_vector,
                    char_id=query.char_id,
                    model_id=self._tuning.model,
                    limit=max(effective.limit * 2, effective.limit),
                    source_types=("memory",),
                    min_score=self._tuning.min_score,
                )
            except Exception as exc:
                self._degrade_embedding(exc)
                return fts
            vector = [RecallBuilder.vector_fact(hit) for hit in hits if hit.source_type == "memory"]
            return rrf_merge_facts(
                fts,
                vector,
                limit=effective.limit,
                fts_weight=self._tuning.fts_weight,
                vector_weight=self._tuning.vector_weight,
            )
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        """列出一个角色的记忆（按重要度、时间倒序）。"""
        store = self._require_store()
        try:
            return store.list_memories(query)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def delete(self, memory_id: int) -> bool:
        """删除一条记忆；不存在返回 False 而不是报错（幂等）。"""
        store = self._require_store()
        try:
            return store.delete_memory(memory_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def edit(
        self,
        memory_id: int,
        *,
        text: str,
        importance: float | None = None,
        kind: str | None = None,
    ) -> tuple[MemoryRecord | None, bool]:
        """改一条 L0 记忆（开发者模式，T2.3-B2）；不存在返回 (None, False)。

        行为观察（kind=action）不给改：它是 usage.db 派生出来的，改了下一次刷新就被覆盖。
        """
        store = self._require_store()
        body = text.strip()
        if not body:
            raise MemoryStoreError(
                CODE_MEM_INDEX_BROKEN,
                "记忆内容为空",
                user_hint="要改成的文本不能是空的。",
            )
        try:
            current = store.get_memory(memory_id)
            if current is None:
                return None, False
            if current.kind == ACTION_KIND:
                raise MemoryStoreError(
                    CODE_MEM_INDEX_BROKEN,
                    "行为观察不可编辑",
                    user_hint="这条是从使用统计里派生的，改了下一轮也会被重新算出来。",
                )
            if kind is None:
                return store.update_memory(memory_id, text=body, importance=importance)
            return store.update_memory(memory_id, text=body, importance=importance, kind=kind)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def reset(self, char_id: str) -> dict[str, int]:
        """完整重置一个角色：原文、事实、摘要、状态全部删除。"""
        store = self._require_store()
        try:
            return store.reset_character(char_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def decay(self, *, now: float | None = None) -> dict[str, int]:
        """软遗忘：给时间桶算强度并标记 dormant / archived；失败只降级。"""
        store = self._store
        if store is None:
            return {"dormant": 0, "archived": 0, "revived": 0}
        moment = now or self._now()
        counts = {"dormant": 0, "archived": 0, "revived": 0}
        try:
            for name in ("decay_periods", "decay_memories"):
                decay = getattr(store, name, None)
                if callable(decay):
                    part = decay(now=moment)
                    for key in counts:
                        counts[key] += int(part.get(key, 0))
        except MemoryBackendError as exc:
            self._degrade(exc, action="decay")
        return counts

    def purge_expired(self, *, now: float | None = None) -> dict[str, int]:
        """清理到期数据；0 天表示关闭自动清理。"""
        store = self._require_store()
        days = self._settings.retention_days
        if days <= 0:
            return {"messages": 0, "summaries": 0, "memories": 0}
        moment = self._now() if now is None else now
        try:
            return store.purge_expired(
                cutoff=moment - days * 86400.0,
                permanent_importance=self._settings.permanent_importance,
            )
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc
