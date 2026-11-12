"""文件职责：上下文注入装配（services/recall_builder.py）的规则测试（需求 §6.4 / §5 F3）。

依赖方向：tests -> services.recall_builder / core.memory / config；全部用假记忆库驱动，
不碰 SQLCipher、不碰 DPAPI——这是把这段逻辑从 memory_service 拆出来的直接收益。
测试重点：两层预算各自裁剪、时间线路径与旧摘要的取舍、语义检索失败自动回退。
谁调用：pytest。
"""

from collections.abc import Sequence

import pytest
from config import MemorySettings
from core.memory import (
    DiaryEntry,
    FactSnippet,
    MemoryIntention,
    MemoryPeriod,
    MemoryQuery,
    MemoryRecord,
    MemoryRelation,
    MessageRow,
    RecallContext,
    RecallQuery,
    SummarySnippet,
    VectorHit,
)
from services.recall_builder import RecallBuilder, RecallTuning, _fit_history, _relation_text

CHAR = "amber"
NOW = 1_700_000_000.0
#: 10 个汉字 = 10 token（estimate_tokens 对 CJK 每字 1）
TEN = "这是一句十个汉字的话"


def _fact(memory_id: int, text: str = TEN, *, score: float = 1.0) -> FactSnippet:
    return FactSnippet(
        memory_id=memory_id,
        kind="fact",
        text=text,
        importance=0.5,
        score=score,
        occurred_at=NOW,
    )


def _summary(summary_id: int, tier: int, text: str = TEN) -> SummarySnippet:
    return SummarySnippet(summary_id=summary_id, tier=tier, text=text, covers_to=NOW)


def _period(period_id: int, level: str, text: str = TEN) -> MemoryPeriod:
    return MemoryPeriod(
        period_id=period_id,
        char_id=CHAR,
        level=level,
        period_start=NOW,
        period_end=NOW + 60,
        summary=text,
    )


def _row(message_id: int, text: str = TEN) -> MessageRow:
    return MessageRow(
        message_id=message_id,
        char_id=CHAR,
        session_id="s1",
        role="user",
        text=text,
        ts=NOW + message_id,
        token_len=len(text),
    )


class FakeStore:
    """按需返回数据、按需报错的假记忆库；调用记录用来断言「有没有走这条路」。"""

    def __init__(
        self,
        *,
        impression: SummarySnippet | None = None,
        summaries: Sequence[SummarySnippet] = (),
        facts: Sequence[FactSnippet] = (),
        observations: Sequence[MemoryRecord] = (),
        history: Sequence[MessageRow] = (),
        periods: Sequence[MemoryPeriod] = (),
        searched_periods: Sequence[MemoryPeriod] = (),
        diary: Sequence[DiaryEntry] = (),
        intentions: Sequence[MemoryIntention] = (),
        relation: MemoryRelation | None = None,
        vector_error: Exception | None = None,
        vector_hits: Sequence[VectorHit] = (),
    ) -> None:
        self.impression = impression
        self.summaries = list(summaries)
        self.facts = list(facts)
        self.observations = list(observations)
        self.history = list(history)
        self.periods = list(periods)
        self.searched_periods = list(searched_periods)
        self.diary = list(diary)
        self.intentions = list(intentions)
        self.relation = relation
        self.vector_error = vector_error
        self.vector_hits = list(vector_hits)
        self.embedding_calls = 0

    # ---- v1 路径用到的读法 ----
    def latest_summary(self, char_id: str, limit: int) -> SummarySnippet | None:
        return self.impression

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        return [row for row in self.summaries if row.tier == tier][:limit]

    def search_memories(self, query: RecallQuery) -> list[FactSnippet]:
        return self.facts[: query.limit]

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        return [row for row in self.observations if row.kind == query.kind][: query.limit]

    def recent_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        return self.history[-limit:]

    # ---- v2 路径额外用到的读法 ----
    def list_periods(
        self, char_id: str, *, levels: tuple[str, ...] = (), limit: int = 40
    ) -> list[MemoryPeriod]:
        return [row for row in self.periods if not levels or row.level in levels][:limit]

    def search_periods(self, char_id: str, *, query: str, limit: int) -> list[MemoryPeriod]:
        return self.searched_periods[:limit]

    def list_diary(self, char_id: str, *, limit: int) -> list[DiaryEntry]:
        return self.diary[:limit]

    def list_intentions(self, char_id: str, *, limit: int) -> list[MemoryIntention]:
        return self.intentions[:limit]

    def get_relation(self, char_id: str) -> MemoryRelation | None:
        return self.relation

    def search_embeddings(
        self,
        vector: Sequence[float],
        *,
        char_id: str,
        model_id: str,
        limit: int,
        source_types: tuple[str, ...] = (),
        min_score: float = 0.0,
    ) -> list[VectorHit]:
        self.embedding_calls += 1
        if self.vector_error is not None:
            raise self.vector_error
        return [hit for hit in self.vector_hits if hit.source_type in source_types][:limit]


def _builder(store: FakeStore, settings: MemorySettings, **kwargs: object) -> RecallBuilder:
    return RecallBuilder(settings, store, **kwargs)  # type: ignore[arg-type]


def test_each_layer_is_trimmed_by_its_own_budget() -> None:
    store = FakeStore(
        impression=_summary(1, 3, TEN * 5),
        summaries=[_summary(2, 1)],
        facts=[_fact(10), _fact(11)],
        history=[_row(1), _row(2)],
    )
    settings = MemorySettings(
        timeline_enabled=False,
        l3_budget_tokens=10,
        l1_budget_tokens=100,
        l2_budget_tokens=0,
        recall_budget_tokens=10,
        history_budget_tokens=10,
        observation_budget_tokens=0,
    )

    context = _builder(store, settings).compose(char_id=CHAR, query="今天", now=NOW)

    # 只截断不丢整层：预算 10 时给省略号留了一格，所以末尾是「…」
    assert context.impressions.startswith("这是一句十个汉字")
    assert context.impressions.endswith("…")
    assert [f.memory_id for f in context.facts] == [10]
    assert len(context.history) == 1
    assert set(context.dropped) >= {"l0", "history"}
    assert context.injected_ids == (10,)


def test_zero_budget_layer_is_never_query() -> None:
    class Exploding(FakeStore):
        def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
            raise AssertionError("预算为 0 的层不该去查库")

        def recent_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
            raise AssertionError("预算为 0 的层不该去查库")

    store = Exploding(facts=[_fact(1)])
    settings = MemorySettings(
        timeline_enabled=False,
        recall_budget_tokens=10,
        observation_budget_tokens=0,
        history_budget_tokens=0,
        l3_budget_tokens=0,
    )

    context = _builder(store, settings).compose(char_id=CHAR, query="", now=NOW)

    assert context.observations == ()
    assert context.history == ()


def test_timeline_path_uses_periods_instead_of_legacy_summaries() -> None:
    store = FakeStore(
        periods=[_period(1, "day", "今天的摘要"), _period(2, "episode", "一小段")],
        summaries=[_summary(9, 1, "旧的一级摘要")],
        facts=[_fact(10)],
    )
    settings = MemorySettings(timeline_enabled=True)

    context = _builder(store, settings).compose(char_id=CHAR, query="", now=NOW)

    assert context.timeline == ("今天的摘要",)
    assert context.episodes == ("一小段",)
    assert context.summaries == ()  # 有时间线时不再塞旧摘要


def test_timeline_path_falls_back_to_legacy_summaries_when_empty() -> None:
    store = FakeStore(summaries=[_summary(9, 2, "旧的一级摘要")])
    settings = MemorySettings(timeline_enabled=True)

    context = _builder(store, settings).compose(char_id=CHAR, query="", now=NOW)

    assert context.timeline == ()
    assert context.episodes == ("旧的一级摘要",)


def test_searched_periods_are_merged_and_deduplicated() -> None:
    latest = [_period(1, "day", "最近的")]
    older = [_period(1, "day", "最近的"), _period(7, "week", "很久以前")]
    store = FakeStore(periods=latest, searched_periods=older)
    settings = MemorySettings(timeline_enabled=True, timeline_limit=4)

    context = _builder(store, settings).compose(char_id=CHAR, query="以前", now=NOW)

    assert context.timeline == ("最近的", "很久以前")


def test_vector_path_is_skipped_when_model_is_empty() -> None:
    store = FakeStore(facts=[_fact(1)], vector_error=AssertionError("没配模型不该走向量"))
    settings = MemorySettings(timeline_enabled=False)

    _builder(store, settings).compose(char_id=CHAR, query="今天", now=NOW, query_vector=[0.1])

    assert store.embedding_calls == 0


def test_vector_failure_degrades_to_fts_instead_of_raising() -> None:
    store = FakeStore(facts=[_fact(1)], vector_error=RuntimeError("模型没加载"))
    settings = MemorySettings(timeline_enabled=False)
    degraded: list[Exception] = []

    context = _builder(
        store,
        settings,
        tuning=RecallTuning(model="bge-small"),
        on_embedding_error=degraded.append,
    ).compose(char_id=CHAR, query="今天", now=NOW, query_vector=[0.1])

    assert [f.memory_id for f in context.facts] == [1]
    assert len(degraded) == 1
    assert isinstance(degraded[0], RuntimeError)


def test_vector_hits_are_merged_into_facts() -> None:
    store = FakeStore(
        facts=[_fact(1, "全文命中")],
        vector_hits=[
            VectorHit(
                source_type="memory",
                source_id=2,
                char_id=CHAR,
                text="向量命中",
                score=0.9,
                kind="fact",
                importance=0.6,
                occurred_at=NOW,
            )
        ],
    )
    settings = MemorySettings(timeline_enabled=False, recall_limit=4)

    context = _builder(
        store, settings, tuning=RecallTuning(model="bge-small")
    ).compose(char_id=CHAR, query="今天", now=NOW, query_vector=[0.1])

    assert {f.memory_id for f in context.facts} == {1, 2}


def test_history_keeps_newest_and_returns_chronological_order() -> None:
    rows = [_row(1, TEN), _row(2, TEN), _row(3, TEN)]

    turns = _fit_history(rows, 20)

    assert len(turns) == 2  # 预算只够最新两条
    assert [turn.ts for turn in turns] == [NOW + 2, NOW + 3]  # 再翻回时间正序


def test_relation_text_respects_zero_budget() -> None:
    relation = MemoryRelation(char_id=CHAR, familiarity=0.87, unresolved="还没解释清楚")

    assert _relation_text(relation, budget=0) == ""
    text = _relation_text(relation, budget=50)
    assert "熟悉度 0.87" in text
    assert "还没解释清楚" in text
