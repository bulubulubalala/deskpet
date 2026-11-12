"""文件职责：上下文注入的「取数 → 裁剪 → 组装」（需求 §6.4 / §5 F3，从 memory_service 拆出）。

依赖方向：services -> core / contracts；只读 MemoryStore（由调用方注入），不碰适配器与密钥。
谁调用：MemoryService._compose_recall()；preview_context() 走同一条路（只是不 mark_used）。
为什么单独成文件：这一段占原 memory_service 三分之一，且与「记什么」的写入逻辑互不相干——
预算怎么裁、哪层先丢、语义检索怎么融合，是可以脱离数据库单独测的规则。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

from config import MemorySettings
from core.emotion import detect_emotion
from core.logging import get_logger, log_event
from core.memory import (
    DiaryEntry,
    FactSnippet,
    HistoryTurn,
    MemoryIntention,
    MemoryPeriod,
    MemoryQuery,
    MemoryRelation,
    MemoryStore,
    MessageRow,
    RecallContext,
    RecallQuery,
    SummarySnippet,
    VectorHit,
    estimate_tokens,
    rrf_merge_facts,
    truncate_to_tokens,
)

LOGGER = get_logger("services.recall_builder")


@dataclass(frozen=True)
class RecallTuning:
    """语义检索的调参（未启用时 model 为空，整条向量路径跳过）。"""

    model: str = ""
    min_score: float = 0.0
    fts_weight: float = 0.35
    vector_weight: float = 0.65


class RecallBuilder:
    """一次「组装下一轮注入」的只读过程：store 给数据，这里只决定留多少、按什么顺序。"""

    def __init__(
        self,
        settings: MemorySettings,
        store: MemoryStore,
        *,
        tuning: RecallTuning | None = None,
        on_embedding_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._settings = settings
        self._store = store
        self._tuning = tuning or RecallTuning()
        self._on_error = on_embedding_error or _log_embedding_error

    def compose(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
    ) -> RecallContext:
        return self._compose_recall(
            char_id=char_id, query=query, now=now, query_vector=query_vector
        )

    def _require_store(self) -> MemoryStore:
        return self._store

    # ---- 内部：取数 → 裁剪 → 组装 ----

    def _compose_recall(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
    ) -> RecallContext:
        """按开关选择时间线装配或旧 L1-L3 装配；两条路都只读，不写库。"""
        if self._settings.timeline_enabled and _timeline_supported(self._store):
            return self._fit_recall_v2(
                self._load_recall_v2(
                    char_id=char_id, query=query, now=now, query_vector=query_vector
                )
            )
        return self._fit_recall(
            self._load_recall(char_id=char_id, query=query, now=now, query_vector=query_vector)
        )

    def _load_recall_v2(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
    ) -> tuple[
        SummarySnippet | None,
        list[MemoryPeriod],
        list[MemoryPeriod],
        list[DiaryEntry],
        list[MemoryIntention],
        MemoryRelation | None,
        list[FactSnippet],
        list[FactSnippet],
        list[MessageRow],
        list[SummarySnippet],
        list[SummarySnippet],
    ]:
        """时间线路径：关系 / 时间桶 / 日记 / 前瞻 / 事实 / 历史；旧摘要作回退。"""
        store = self._require_store()
        cfg = self._settings
        impressions = store.latest_summary(char_id, 3) if cfg.l3_budget_tokens > 0 else None
        latest_timeline = (
            store.list_periods(
                char_id,
                levels=("day", "week", "month"),
                limit=cfg.timeline_limit,
            )
            if cfg.timeline_budget_tokens > 0 and cfg.timeline_limit > 0
            else []
        )
        timeline = self._relevant_periods(
            store,
            char_id,
            query,
            query_vector,
            latest=latest_timeline,
            limit=cfg.timeline_limit,
        )
        episodes = (
            store.list_periods(char_id, levels=("episode",), limit=cfg.episode_limit)
            if cfg.l1_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        diary = (
            store.list_diary(char_id, limit=cfg.diary_limit)
            if cfg.diary_budget_tokens > 0 and cfg.diary_limit > 0
            else []
        )
        intentions = (
            store.list_intentions(char_id, limit=cfg.intention_limit)
            if cfg.intention_budget_tokens > 0 and cfg.intention_limit > 0
            else []
        )
        relation = store.get_relation(char_id) if cfg.relation_budget_tokens > 0 else None
        facts, observations = self._load_facts(store, char_id, query, now, query_vector)
        history = (
            store.recent_messages(char_id, limit=cfg.history_turns * 2)
            if cfg.history_turns > 0 and cfg.history_budget_tokens > 0
            else []
        )
        legacy_episodes = (
            store.list_summaries(char_id, 2, limit=cfg.episode_limit)
            if cfg.l2_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        legacy_summaries = (
            store.list_summaries(char_id, 1, limit=cfg.episode_limit)
            if cfg.l2_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        return (
            impressions,
            timeline,
            episodes,
            diary,
            intentions,
            relation,
            facts,
            observations,
            history,
            legacy_episodes,
            legacy_summaries,
        )

    def _fit_recall_v2(
        self,
        loaded: tuple[
            SummarySnippet | None,
            list[MemoryPeriod],
            list[MemoryPeriod],
            list[DiaryEntry],
            list[MemoryIntention],
            MemoryRelation | None,
            list[FactSnippet],
            list[FactSnippet],
            list[MessageRow],
            list[SummarySnippet],
            list[SummarySnippet],
        ],
    ) -> RecallContext:
        """时间线路径的预算裁剪；新时间桶为空时自动用旧 L1/L2 摘要补位。"""
        cfg = self._settings
        (
            impressions_row,
            timeline,
            episodes,
            diary,
            intentions,
            relation,
            facts,
            observations,
            history,
            legacy_episodes,
            legacy_summaries,
        ) = loaded
        dropped: list[str] = []
        impressions = ""
        if impressions_row is not None:
            impressions = truncate_to_tokens(impressions_row.text, cfg.l3_budget_tokens)
            if not impressions:
                dropped.append("l3")
        relationship = _relation_text(relation, budget=cfg.relation_budget_tokens)
        if relation is not None and not relationship:
            dropped.append("relation")

        timeline_texts = [item.summary for item in timeline]
        kept_timeline = _fit_texts(timeline_texts, cfg.timeline_budget_tokens)
        if len(kept_timeline) < len(timeline_texts):
            dropped.append("timeline")

        episode_texts = [item.summary for item in episodes]
        if not episode_texts:
            episode_texts = [row.text for row in legacy_episodes]
        kept_episodes = _fit_texts(episode_texts, cfg.l1_budget_tokens)
        if len(kept_episodes) < len(episode_texts):
            dropped.append("episode")

        summary_texts = [row.text for row in legacy_summaries] if not timeline_texts else []
        kept_summaries = _fit_texts(summary_texts, cfg.l2_budget_tokens)
        if len(kept_summaries) < len(summary_texts):
            dropped.append("l2")

        diary_texts = [item.text for item in diary]
        kept_diary = _fit_texts(diary_texts, cfg.diary_budget_tokens)
        if len(kept_diary) < len(diary_texts):
            dropped.append("diary")

        intention_texts = [item.text for item in intentions]
        kept_intentions = _fit_texts(intention_texts, cfg.intention_budget_tokens)
        if len(kept_intentions) < len(intention_texts):
            dropped.append("intention")

        kept_observations = _fit_facts(observations, cfg.observation_budget_tokens)
        if len(kept_observations) < len(observations):
            dropped.append("observation")
        kept_facts = _fit_facts(facts, cfg.recall_budget_tokens)
        if len(kept_facts) < len(facts):
            dropped.append("l0")
        kept_history = _fit_history(history, cfg.history_budget_tokens)
        if len(kept_history) < len(history):
            dropped.append("history")
        return RecallContext(
            impressions=impressions,
            episodes=tuple(kept_episodes),
            summaries=tuple(kept_summaries),
            facts=tuple(kept_facts),
            observations=tuple(kept_observations),
            timeline=tuple(kept_timeline),
            diary=tuple(kept_diary),
            intentions=tuple(kept_intentions),
            relationship=relationship,
            history=tuple(kept_history),
            injected_ids=tuple(
                [fact.memory_id for fact in kept_facts]
                + [item.memory_id for item in kept_observations]
            ),
            dropped=tuple(dropped),
        )

    def _relevant_periods(
        self,
        store: MemoryStore,
        char_id: str,
        query: str,
        query_vector: Sequence[float] | None,
        *,
        latest: Sequence[MemoryPeriod],
        limit: int,
    ) -> list[MemoryPeriod]:
        """把最新时间线与 query 命中的旧时间桶合并，旧桶也能被想起。"""
        ranked: list[MemoryPeriod] = []
        if query.strip() and limit > 0:
            search = getattr(store, "search_periods", None)
            if callable(search):
                try:
                    ranked.extend(search(char_id, query=query, limit=max(limit, 4)))
                except Exception as exc:
                    self._on_error(exc)
        if query_vector and self._tuning.model and limit > 0:
            try:
                hits = store.search_embeddings(
                    query_vector,
                    char_id=char_id,
                    model_id=self._tuning.model,
                    limit=max(limit, 4),
                    source_types=("period",),
                    min_score=self._tuning.min_score,
                )
                get_period = getattr(store, "get_period", None)
                if callable(get_period):
                    for hit in hits:
                        period = get_period(hit.source_id)
                        if period is not None:
                            ranked.append(period)
            except Exception as exc:
                self._on_error(exc)
        merged: list[MemoryPeriod] = []
        seen: set[int] = set()
        for period in [*ranked, *latest]:
            if period.period_id not in seen:
                seen.add(period.period_id)
                merged.append(period)
        return merged[: max(len(latest) + limit, limit)]

    def _load_facts(
        self,
        store: MemoryStore,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None,
    ) -> tuple[list[FactSnippet], list[FactSnippet]]:
        """事实检索 + 行为观察；时间线/旧路径共用。"""
        cfg = self._settings
        facts = (
            store.search_memories(
                RecallQuery(
                    char_id=char_id,
                    query=query,
                    now=now,
                    limit=cfg.recall_limit,
                    exclude_kinds=("action",),
                )
            )
            if cfg.recall_limit > 0 and cfg.recall_budget_tokens > 0
            else []
        )
        if query_vector and self._tuning.model:
            try:
                vector_hits = store.search_embeddings(
                    query_vector,
                    char_id=char_id,
                    model_id=self._tuning.model,
                    limit=max(cfg.recall_limit * 2, cfg.recall_limit),
                    source_types=("memory",),
                    min_score=self._tuning.min_score,
                )
                vector_facts = [
                    RecallBuilder.vector_fact(hit)
                    for hit in vector_hits
                    if hit.source_type == "memory"
                ]
                facts = rrf_merge_facts(
                    facts,
                    vector_facts,
                    limit=cfg.recall_limit,
                    fts_weight=self._tuning.fts_weight,
                    vector_weight=self._tuning.vector_weight,
                )
            except Exception as exc:
                self._on_error(exc)
        observations = (
            [
                FactSnippet(
                    memory_id=row.memory_id,
                    kind=row.kind,
                    text=row.text,
                    importance=row.importance,
                    score=row.importance,
                    occurred_at=row.created_at,
                )
                for row in store.list_memories(
                    MemoryQuery(char_id=char_id, kind="action", limit=cfg.recall_limit)
                )
            ]
            if cfg.observation_budget_tokens > 0 and cfg.recall_limit > 0
            else []
        )
        return facts, observations

    def _load_recall(
        self,
        *,
        char_id: str,
        query: str,
        now: float,
        query_vector: Sequence[float] | None = None,
    ) -> tuple[
        SummarySnippet | None,
        list[SummarySnippet],
        list[SummarySnippet],
        list[FactSnippet],
        list[FactSnippet],
        list[MessageRow],
    ]:
        """一次性把六层数据取出来（读失败由调用方降级）。"""
        store = self._require_store()
        cfg = self._settings
        impressions = store.latest_summary(char_id, 3) if cfg.l3_budget_tokens > 0 else None
        episodes = (
            store.list_summaries(char_id, 2, limit=cfg.episode_limit)
            if cfg.l2_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        summaries = (
            store.list_summaries(char_id, 1, limit=cfg.episode_limit)
            if cfg.l1_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        facts = (
            store.search_memories(
                RecallQuery(
                    char_id=char_id,
                    query=query,
                    now=now,
                    limit=cfg.recall_limit,
                    # 行为观察单独成段，不占用户事实的检索名额（T2.1c）
                    exclude_kinds=("action",),
                )
            )
            if cfg.recall_limit > 0 and cfg.recall_budget_tokens > 0
            else []
        )
        if query_vector and self._tuning.model:
            try:
                vector_hits = store.search_embeddings(
                    query_vector,
                    char_id=char_id,
                    model_id=self._tuning.model,
                    limit=max(cfg.recall_limit * 2, cfg.recall_limit),
                    source_types=("memory",),
                    min_score=self._tuning.min_score,
                )
                vector_facts = [
                    RecallBuilder.vector_fact(hit)
                    for hit in vector_hits
                    if hit.source_type == "memory"
                ]
                facts = rrf_merge_facts(
                    facts,
                    vector_facts,
                    limit=cfg.recall_limit,
                    fts_weight=self._tuning.fts_weight,
                    vector_weight=self._tuning.vector_weight,
                )
            except Exception as exc:
                self._on_error(exc)
        observations = (
            [
                FactSnippet(
                    memory_id=row.memory_id,
                    kind=row.kind,
                    text=row.text,
                    importance=row.importance,
                    score=row.importance,
                    occurred_at=row.created_at,
                )
                for row in store.list_memories(
                    MemoryQuery(char_id=char_id, kind="action", limit=cfg.recall_limit)
                )
            ]
            if cfg.observation_budget_tokens > 0 and cfg.recall_limit > 0
            else []
        )
        history = (
            store.recent_messages(char_id, limit=cfg.history_turns * 2)
            if cfg.history_turns > 0 and cfg.history_budget_tokens > 0
            else []
        )
        return impressions, episodes, summaries, facts, observations, history

    def _fit_recall(
        self,
        loaded: tuple[
            SummarySnippet | None,
            list[SummarySnippet],
            list[SummarySnippet],
            list[FactSnippet],
            list[FactSnippet],
            list[MessageRow],
        ],
    ) -> RecallContext:
        """六层数据各自压进自己的预算（§6.4）：历史 / 观察 / L0 / L1 / L2 互不抢额度，L3 只截不丢。

        dropped 里记下被裁过的层名，供 chat.start 日志与实测核对。
        """
        cfg = self._settings
        impressions_row, episodes, summaries, facts, observations, history = loaded
        dropped: list[str] = []
        impressions = ""
        if impressions_row is not None:
            impressions = truncate_to_tokens(impressions_row.text, cfg.l3_budget_tokens)
            if not impressions:
                dropped.append("l3")
        kept_episodes = _fit_texts([row.text for row in episodes], cfg.l2_budget_tokens)
        if len(kept_episodes) < len(episodes):
            dropped.append("l2")
        kept_summaries = _fit_texts([row.text for row in summaries], cfg.l1_budget_tokens)
        if len(kept_summaries) < len(summaries):
            dropped.append("l1")
        kept_observations = _fit_facts(observations, cfg.observation_budget_tokens)
        if len(kept_observations) < len(observations):
            dropped.append("observation")
        kept_facts = _fit_facts(facts, cfg.recall_budget_tokens)
        if len(kept_facts) < len(facts):
            dropped.append("l0")
        kept_history = _fit_history(history, cfg.history_budget_tokens)
        if len(kept_history) < len(history):
            dropped.append("history")
        return RecallContext(
            impressions=impressions,
            episodes=tuple(kept_episodes),
            summaries=tuple(kept_summaries),
            facts=tuple(kept_facts),
            observations=tuple(kept_observations),
            history=tuple(kept_history),
            injected_ids=tuple(
                [fact.memory_id for fact in kept_facts]
                + [item.memory_id for item in kept_observations]
            ),
            dropped=tuple(dropped),
        )

    @staticmethod
    @staticmethod
    def vector_fact(hit: VectorHit) -> FactSnippet:
        return FactSnippet(
            memory_id=hit.source_id,
            kind=hit.kind or "fact",
            text=hit.text,
            importance=hit.importance,
            score=hit.score,
            occurred_at=hit.occurred_at,
        )


def _timeline_supported(store: MemoryStore | None) -> bool:
    """旧测试替身 / 旧存储没有时间线方法时自动走 v1，不要求全量实现。"""
    if store is None:
        return False
    return all(
        callable(getattr(store, name, None))
        for name in ("list_periods", "list_diary", "list_intentions", "get_relation")
    )


def _relation_text(relation: MemoryRelation | None, *, budget: int) -> str:
    """把结构化关系记忆压成一段很短的注入文本。"""
    if relation is None or budget <= 0:
        return ""
    parts = [
        f"熟悉度 {relation.familiarity:.2f}",
        f"信任 {relation.trust:.2f}",
        f"亲近 {relation.warmth:.2f}",
    ]
    if relation.unresolved.strip():
        parts.append("还没解决：" + relation.unresolved.strip())
    if relation.recent_conflict.strip():
        parts.append("最近的别扭：" + relation.recent_conflict.strip())
    return truncate_to_tokens("；".join(parts), budget)


def _fit_texts(texts: Sequence[str], budget: int) -> list[str]:
    """按顺序装文本，装到预算用完为止（顺序即优先级）。"""
    if budget <= 0:
        return []
    kept: list[str] = []
    used = 0
    for text in texts:
        cost = estimate_tokens(text)
        if used + cost > budget:
            break
        kept.append(text)
        used += cost
    return kept


def _fit_facts(facts: Sequence[FactSnippet], budget: int) -> list[FactSnippet]:
    """与 _fit_texts 同规则，只是元素换成带 id 的片段（要看 id 做 mark_used）。"""
    if budget <= 0:
        return []
    kept: list[FactSnippet] = []
    used = 0
    for fact in facts:
        cost = estimate_tokens(fact.text)
        if used + cost > budget:
            break
        kept.append(fact)
        used += cost
    return kept


def rerank_facts(facts: Sequence[FactSnippet], mood_valence: float) -> list[FactSnippet]:
    """情绪一致性：同向情绪的事实加一点分，不改变原来的基础排序。"""
    adjusted: list[FactSnippet] = []
    for fact in facts:
        emotion = detect_emotion(fact.text).valence
        bonus = 0.08 if emotion * mood_valence > 0.1 else 0.0
        adjusted.append(replace(fact, score=fact.score + bonus) if bonus else fact)
    adjusted.sort(key=lambda item: item.score, reverse=True)
    return adjusted


def _fit_history(rows: Sequence[MessageRow], budget: int) -> list[HistoryTurn]:
    """历史从最新往回装（越近越重要），装完再翻回时间正序给模型。"""
    if budget <= 0:
        return []
    kept: list[MessageRow] = []
    used = 0
    for row in reversed(list(rows)):
        cost = estimate_tokens(row.text)
        if used + cost > budget:
            break
        kept.append(row)
        used += cost
    turns = [
        HistoryTurn(
            role="assistant" if row.role == "assistant" else "user",
            text=row.text,
            ts=row.ts,
        )
        for row in reversed(kept)
    ]
    return turns


def _log_embedding_error(exc: Exception) -> None:
    log_event(
        LOGGER,
        logging.WARNING,
        module="services.recall_builder",
        event="memory.embedding_degraded",
        message="语义检索失败，回退全文检索",
        fields={"error": str(exc)},
    )
