"""文件职责：时间金字塔 / 日记 / 前瞻 / 关系记忆的存储层测试（T2.33）。"""

from pathlib import Path

import pytest
from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import (
    DiaryDraft,
    MemoryDraft,
    MemoryIntention,
    MemoryRelation,
    MessageDraft,
)

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


def test_messages_between_and_period_sources(store: MemorySqliteStore) -> None:
    ids = store.add_messages(
        [
            MessageDraft(CHAR, "s1", "user", "早上好", NOW, 3),
            MessageDraft(CHAR, "s1", "assistant", "早呀", NOW + 10, 2),
            MessageDraft(CHAR, "s1", "user", "晚上见", NOW + 3600, 3),
        ]
    )
    rows = store.messages_between(CHAR, start=NOW, end=NOW + 100)
    assert [row.message_id for row in rows] == [ids[0], ids[1]]

    period_id = store.upsert_period(
        char_id=CHAR,
        level="episode",
        period_start=NOW,
        period_end=NOW + 100,
        summary="早上打了个招呼。",
        label="10:00",
        day_key="2023-11-14",
        source_hash="h1",
        model_id="m1",
        sources=[("message", ids[0]), ("message", ids[1])],
        now=NOW,
    )
    period = store.get_period(period_id)
    assert period is not None
    assert period.summary == "早上打了个招呼。"
    assert store.period_sources(period_id) == [("message", ids[0]), ("message", ids[1])]
    assert (
        store.list_periods(CHAR, levels=("episode",), limit=5)[0].period_id == period_id
    )


def test_period_manual_edit_is_not_overwritten(store: MemorySqliteStore) -> None:
    period_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="自动摘要",
        now=NOW,
    )
    with store._lock:
        store._connection.execute(
            "UPDATE memory_periods SET edited_at = ? WHERE id = ?", (NOW, period_id)
        )
        store._connection.commit()
    same_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="重建摘要",
        now=NOW + 10,
    )
    assert same_id == period_id
    assert store.get_period(period_id).summary == "自动摘要"
    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="强制重建",
        now=NOW + 20,
        force=True,
    )
    assert store.get_period(period_id).summary == "强制重建"


def test_period_fts_and_period_embeddings(store: MemorySqliteStore) -> None:
    period_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天面试完了，有点累。",
        label="2023-11-14",
        day_key="2023-11-14",
        now=NOW,
    )
    assert [item.period_id for item in store.search_periods(CHAR, query="面试")] == [period_id]
    pending = store.pending_embeddings(model_id="m1", char_id=CHAR, limit=10)
    assert any(item.source_type == "period" and item.source_id == period_id for item in pending)

    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天面试很顺利。",
        label="2023-11-14",
        day_key="2023-11-14",
        now=NOW + 10,
    )
    assert store.search_periods(CHAR, query="顺利")[0].period_id == period_id
    assert store.search_periods(CHAR, query="累") == []

    assert store.delete_period(period_id) is True
    assert store.search_periods(CHAR, query="面试") == []


def test_period_decay_marks_dormant_and_archived(store: MemorySqliteStore) -> None:
    old = NOW - 400 * 86400
    archived_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=old,
        period_end=old + 86400,
        summary="很久以前的一天。",
        day_key="2022-10-01",
        now=old,
    )
    pinned_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=old - 86400,
        period_end=old,
        summary="置顶的一天。",
        day_key="2022-09-30",
        now=old,
    )
    with store._lock:
        store._connection.execute(
            "UPDATE memory_periods SET pinned = 1 WHERE id = ?", (pinned_id,)
        )
        store._connection.commit()

    counts = store.decay_periods(now=NOW)
    assert counts["archived"] >= 1
    visible = store.list_periods(CHAR, limit=10)
    assert [item.period_id for item in visible] == [pinned_id]
    assert store.get_period(archived_id).state == "archived"


def test_diary_intention_relation_roundtrip(store: MemorySqliteStore) -> None:
    diary = store.add_diary(
        DiaryDraft(CHAR, "今天面试完了", NOW + 100, mood="紧张", tags="工作"), now=NOW
    )
    assert store.list_diary(CHAR, limit=5)[0].entry_id == diary.entry_id
    updated = store.update_diary(diary.entry_id, text="今天面试很顺利", mood="开心")
    assert updated is not None and updated.text == "今天面试很顺利"
    assert updated.mood == "开心"

    intention = store.add_intention(
        char_id=CHAR, text="下次问面试结果", trigger_at=NOW + 86400, now=NOW
    )
    assert isinstance(intention, MemoryIntention)
    assert store.list_intentions(CHAR)[0].text == "下次问面试结果"
    assert store.resolve_intention(intention.intention_id, now=NOW + 10) is True
    assert store.list_intentions(CHAR) == []

    store.save_relation(
        MemoryRelation(
            CHAR,
            familiarity=0.7,
            trust=0.8,
            warmth=0.6,
            unresolved="面试",
            updated_at=NOW,
        )
    )
    relation = store.get_relation(CHAR)
    assert relation is not None
    assert relation.trust == 0.8
    assert relation.unresolved == "面试"

    assert store.delete_diary(diary.entry_id) is True
    assert store.list_diary(CHAR) == []


def test_occurred_at_backfills_from_created_at(store: MemorySqliteStore) -> None:
    store.upsert_memory(
        MemoryDraft(CHAR, "fact", "用户喜欢猫", 0.8, occurred_at=NOW - 60), now=NOW
    )
    row = store._connection.execute(
        "SELECT occurred_at, created_at FROM memories WHERE char_id = ?", (CHAR,)
    ).fetchone()
    assert row[0] == NOW - 60
    assert row[1] == NOW - 60
