"""文件职责：时间线路径的记忆装配测试（T2.33）。"""

from pathlib import Path

import pytest
from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import DiaryDraft, MemoryDraft, MemoryRelation, MessageDraft
from services.memory_service import MemoryService

from config import MemorySettings

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0


@pytest.fixture()
def store(tmp_path: Path):
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


def _service(store: MemorySqliteStore, **overrides: object) -> MemoryService:
    settings = MemorySettings(timeline_enabled=True, **overrides)  # type: ignore[arg-type]
    return MemoryService(store, settings, now=lambda: NOW)


def test_timeline_recall_injects_episode_day_diary_intention_relation(
    store: MemorySqliteStore,
) -> None:
    store.upsert_memory(MemoryDraft(CHAR, "fact", "用户喜欢雨天", 0.9, occurred_at=NOW), now=NOW)
    store.add_messages([MessageDraft(CHAR, "s1", "user", "今天下雨了", NOW, 5)])
    store.upsert_period(
        char_id=CHAR,
        level="episode",
        period_start=NOW,
        period_end=NOW + 100,
        summary="今天聊了下雨。",
        day_key="2023-11-14",
        now=NOW,
    )
    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天下雨，他听起来有点安静。",
        day_key="2023-11-14",
        now=NOW,
    )
    store.add_diary(DiaryDraft(CHAR, "今天其实有点累。", NOW, mood="累"), now=NOW)
    store.add_intention(char_id=CHAR, text="下次问他面试结果", now=NOW)
    store.save_relation(MemoryRelation(CHAR, familiarity=0.7, trust=0.8, unresolved="面试"))

    context = _service(store).recall(char_id=CHAR, query="下雨", now=NOW)

    assert "今天下雨，他听起来有点安静。" in context.timeline
    assert context.episodes == ("今天聊了下雨。",)
    assert context.diary == ("今天其实有点累。",)
    assert context.intentions == ("下次问他面试结果",)
    assert "信任 0.80" in context.relationship
    assert any("雨天" in fact.text for fact in context.facts)


def test_timeline_recall_finds_older_period_by_query(store: MemorySqliteStore) -> None:
    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW - 30 * 86400,
        period_end=NOW - 29 * 86400,
        summary="那天聊了面试结果，他说还在等通知。",
        day_key="2023-10-15",
        now=NOW,
    )
    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天聊了晚饭。",
        day_key="2023-11-14",
        now=NOW,
    )

    context = _service(store).recall(char_id=CHAR, query="面试", now=NOW)

    assert any("面试结果" in text for text in context.timeline)


def test_recall_prioritizes_mood_congruent_fact(store: MemorySqliteStore) -> None:
    store.upsert_memory(
        MemoryDraft(CHAR, "event", "今天面试很顺利，我很开心", 0.8, occurred_at=NOW), now=NOW
    )
    store.upsert_memory(
        MemoryDraft(CHAR, "event", "今天很累，也有点焦虑", 0.8, occurred_at=NOW), now=NOW
    )

    context = _service(store).recall(
        char_id=CHAR, query="", now=NOW, mood_valence=-0.8
    )

    assert context.facts[0].text == "今天很累，也有点焦虑"


def test_timeline_recall_falls_back_to_legacy_summaries(store: MemorySqliteStore) -> None:
    store.add_summary(
        char_id=CHAR,
        tier=2,
        text="前阵子聊过工作。",
        covers_from=NOW - 100,
        covers_to=NOW,
        now=NOW,
    )
    store.add_summary(
        char_id=CHAR,
        tier=1,
        text="他最近在准备面试。",
        covers_from=NOW - 100,
        covers_to=NOW,
        now=NOW,
    )

    context = _service(store).recall(char_id=CHAR, query="", now=NOW)

    assert context.episodes == ("前阵子聊过工作。",)
    assert context.summaries == ("他最近在准备面试。",)
