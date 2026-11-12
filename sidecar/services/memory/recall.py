"""文件职责：注入装配：这一轮该把哪些记忆拼成提示词（检索 + 预算裁剪 + 干跑预览）。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from core.memory import (
    MemoryBackendError,
    RecallContext,
)
from services.recall_builder import RecallBuilder, rerank_facts

from .base import MemoryServiceBase


class RecallMixin(MemoryServiceBase):
    """注入装配：这一轮该把哪些记忆拼成提示词（检索 + 预算裁剪 + 干跑预览）。"""

    def recall(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
        mood_valence: float = 0.0,
    ) -> RecallContext:
        """按预算取一轮要注入的记忆；任何失败都返回「空记忆」并降级上报。"""
        if self._store is None:
            return RecallContext()
        try:
            context = self._compose_recall(
                char_id=char_id, query=query, now=now, query_vector=query_vector
            )
            if mood_valence and context.facts:
                context = replace(context, facts=tuple(rerank_facts(context.facts, mood_valence)))
        except MemoryBackendError as exc:
            self._degrade(exc, action="recall")
            return RecallContext()
        if context.injected_ids:
            try:
                self._store.mark_used(list(context.injected_ids), now=now)
            except MemoryBackendError as exc:
                self._degrade(exc, action="mark_used")
        return context

    def _compose_recall(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
    ) -> RecallContext:
        """取数与裁剪交给 RecallBuilder；这里只负责给出 store 与当前语义检索调参。"""
        return RecallBuilder(
            self._settings,
            self._require_store(),
            tuning=self._tuning,
            on_embedding_error=self._degrade_embedding,
        ).compose(char_id=char_id, query=query, now=now, query_vector=query_vector)

    def preview_context(self, *, char_id: str, query: str, now: float = 0.0) -> RecallContext:
        """干跑一次「下一轮会注入什么」（开发者模式「注入上下文」页，T2.3-B1）。

        与 recall() 的唯一区别是**不调 mark_used**：预览不该改变「用过几次」和新鲜度。
        与 recall() 的另一个区别是失败要抛（用户主动看的时候必须看见原因）。
        """
        self._require_store()  # 库不可用时立刻抛 DP-MEM-*，预览不该静默
        moment = now if now > 0 else self._now()
        try:
            return self._compose_recall(char_id=char_id, query=query, now=moment)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    @property
    def budgets(self) -> dict[str, int]:
        """各记忆段注入预算（token），供开发者模式的预览页标出「这段用了多少 / 上限多少」。"""
        cfg = self._settings
        return {
            "observations": cfg.observation_budget_tokens,
            "l3": cfg.l3_budget_tokens,
            "l2": cfg.l2_budget_tokens,
            "l1": cfg.l1_budget_tokens,
            "timeline": cfg.timeline_budget_tokens,
            "diary": cfg.diary_budget_tokens,
            "relation": cfg.relation_budget_tokens,
            "intention": cfg.intention_budget_tokens,
            "facts": cfg.recall_budget_tokens,
            "history": cfg.history_budget_tokens,
        }
