"""文件职责：加密记忆库（SQLCipher + FTS5）的读写测试（需求 §6.4 / §6.5；PLAN T2.1a）。

依赖方向：tests -> adapters.memory_sqlite / core.memory；需要本机装有 sqlcipher3
（sidecar/pyproject.toml 的依赖，Windows 轮子自带 amalgamation，不需要外部 DLL）。
谁调用：pytest（Windows 侧的 .venv 里跑）。
"""

import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from adapters.memory_sqlite import SCHEMA_VERSION, MemorySqliteStore, open_memory_store
from core.memory import (
    MemoryDraft,
    MemoryKeyInvalidError,
    MemoryQuery,
    MessageDraft,
    RecallQuery,
)

#: 测试密钥（真实密钥是 32 字节随机数，由 adapters.memory_key 保管）
KEY = bytes(range(1, 33))
#: 另一个同样合法但不同的密钥：用来验证「密钥不匹配」这条路径
OTHER_KEY = bytes(range(33, 65))

CHAR = "amber"
NOW = 1_700_000_000.0


@pytest.fixture()
def store(tmp_path: Path) -> Iterator[MemorySqliteStore]:
    """每个用例一个全新的加密库（在临时目录里，跑完就删）。"""
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


def _message(text: str, *, role: str = "user", ts: float = NOW) -> MessageDraft:
    return MessageDraft(
        char_id=CHAR,
        session_id="s1",
        role=role,  # type: ignore[arg-type]
        text=text,
        ts=ts,
        token_len=len(text),
    )


def _memory(text: str, *, importance: float = 0.5, kind: str = "fact", occurred_at: float = NOW) -> MemoryDraft:
    return MemoryDraft(
        char_id=CHAR,
        kind=kind,  # type: ignore[arg-type]
        text=text,
        importance=importance,
        occurred_at=occurred_at,
    )


def test_new_store_is_created_and_encrypted(tmp_path: Path) -> None:
    """建库后文件存在，且**不是**明文 SQLite（整个库加密是本项目对隐私的硬要求）。"""
    path = tmp_path / "nested" / "memories.db"
    opened = open_memory_store(path, key=KEY)
    try:
        assert path.is_file()
        assert path.read_bytes()[:16] != b"SQLite format 3\x00"
    finally:
        opened.close()


def test_schema_version_is_written(store: MemorySqliteStore) -> None:
    """user_version 必须写上，将来才能判断「库比程序新」。"""
    assert SCHEMA_VERSION == 1
    assert store.path.name == "memories.db"


def test_wrong_key_raises_key_invalid(tmp_path: Path) -> None:
    """用错密钥开库必须在构造时就报 DP-MEM-001 级别的原因，而不是等某次查询崩。"""
    path = tmp_path / "memories.db"
    first = open_memory_store(path, key=KEY)
    first.close()
    with pytest.raises(MemoryKeyInvalidError):
        open_memory_store(path, key=OTHER_KEY)


def test_key_must_be_32_bytes(tmp_path: Path) -> None:
    with pytest.raises(MemoryKeyInvalidError):
        MemorySqliteStore(tmp_path / "memories.db", key=b"short")


def test_messages_roundtrip_in_chronological_order(store: MemorySqliteStore) -> None:
    """历史按 id 升序回给模型：最近 limit 条，且**从旧到新**。"""
    ids = store.add_messages([_message("第一句"), _message("第二句"), _message("第三句")])
    assert len(ids) == 3
    assert store.count_messages(CHAR) == 3
    recent = store.recent_messages(CHAR, limit=2)
    assert [row.text for row in recent] == ["第二句", "第三句"]
    assert [row.message_id for row in recent] == [ids[1], ids[2]]
    assert store.recent_messages(CHAR, limit=0) == []


def test_uncovered_messages_and_mark_covered(store: MemorySqliteStore) -> None:
    """未覆盖消息是 T2.1b 摘要的输入；标记覆盖后不再出现，但原文仍然在。"""
    ids = store.add_messages([_message("甲"), _message("乙")])
    uncovered = store.uncovered_messages(CHAR, limit=10)
    assert [row.text for row in uncovered] == ["甲", "乙"]
    assert store.mark_covered(ids[:1], summary_id=7) == 1
    assert [row.text for row in store.uncovered_messages(CHAR, limit=10)] == ["乙"]
    assert store.count_messages(CHAR) == 2, "覆盖不是删除"
    assert store.mark_covered([], summary_id=7) == 0


def test_upsert_memory_dedups_by_normalized_text(store: MemorySqliteStore) -> None:
    """同一角色 + 同一句话（忽略大小写与空白）算同一条，只把重要度抬上去。"""
    first_id, deduped = store.upsert_memory(
        _memory("用户养了一只叫团子的猫", importance=0.4), now=NOW
    )
    assert deduped is False, "首次写入不算去重"
    second_id, deduped_again = store.upsert_memory(
        _memory("  用户养了一只叫团子的猫 ", importance=0.9), now=NOW + 10
    )
    assert deduped_again is True
    assert second_id == first_id
    records = store.list_memories(MemoryQuery(char_id=CHAR))
    assert len(records) == 1
    assert records[0].importance == pytest.approx(0.9)


def test_upsert_memory_keeps_higher_importance(store: MemorySqliteStore) -> None:
    """重复写入更低的重要度不能把它拉下来。"""
    memory_id, _ = store.upsert_memory(_memory("用户讨厌香菜", importance=0.8), now=NOW)
    store.upsert_memory(_memory("用户讨厌香菜", importance=0.2), now=NOW)
    records = store.list_memories(MemoryQuery(char_id=CHAR))
    assert records[0].memory_id == memory_id
    assert records[0].importance == pytest.approx(0.8)


def test_search_memories_finds_chinese_words(store: MemorySqliteStore) -> None:
    """中文全文检索靠「我们自己分词 + FTS5」实现：搜「猫」必须命中那句。"""
    store.upsert_memory(_memory("用户养了一只叫团子的猫"), now=NOW)
    store.upsert_memory(_memory("用户在上海工作"), now=NOW)
    hits = store.search_memories(RecallQuery(char_id=CHAR, query="猫", now=NOW))
    assert [hit.text for hit in hits] == ["用户养了一只叫团子的猫"]


def test_search_memories_without_terms_falls_back_to_recent(store: MemorySqliteStore) -> None:
    """查询里没有可检索词（全是标点 / 空串）时退化成「最近写的几条」，不能报错。"""
    store.upsert_memory(_memory("旧的一条", occurred_at=NOW - 100), now=NOW - 100)
    store.upsert_memory(_memory("新的一条", occurred_at=NOW), now=NOW)
    hits = store.search_memories(RecallQuery(char_id=CHAR, query="？？", now=NOW))
    assert [hit.text for hit in hits][0] == "新的一条"


def test_search_memories_respects_min_importance_and_limit(store: MemorySqliteStore) -> None:
    for index in range(5):
        store.upsert_memory(
            _memory("重要度测试 %d" % index, importance=0.1 * index, occurred_at=NOW + index),
            now=NOW + index,
        )
    hits = store.search_memories(RecallQuery(char_id=CHAR, query="重要度", now=NOW, limit=2))
    assert len(hits) == 2
    assert all(hit.importance >= 0.0 for hit in hits)
    filtered = store.search_memories(
        RecallQuery(char_id=CHAR, query="重要度", now=NOW, min_importance=0.35)
    )
    assert all(hit.importance >= 0.35 for hit in filtered)


def test_list_memories_filters_by_kind_and_tier(store: MemorySqliteStore) -> None:
    store.upsert_memory(_memory("事实一", kind="fact"), now=NOW)
    store.upsert_memory(_memory("偏好一", kind="preference", importance=0.7), now=NOW)
    everything = store.list_memories(MemoryQuery(char_id=CHAR))
    assert len(everything) == 2
    assert everything[0].text == "偏好一", "列表按重要度倒序"
    only_preference = store.list_memories(MemoryQuery(char_id=CHAR, kind="preference"))
    assert [record.text for record in only_preference] == ["偏好一"]
    assert store.list_memories(MemoryQuery(char_id=CHAR, tier="l3")) == []


def test_delete_memory_is_idempotent_and_drops_index_row(store: MemorySqliteStore) -> None:
    memory_id, _ = store.upsert_memory(_memory("用户养了一只叫团子的猫"), now=NOW)
    assert store.delete_memory(memory_id) is True
    assert store.delete_memory(memory_id) is False, "删两次不该报错"
    assert store.list_memories(MemoryQuery(char_id=CHAR)) == []
    assert store.search_memories(RecallQuery(char_id=CHAR, query="猫", now=NOW)) == [], "索引行也要删"


def test_clear_memories_all_or_older_than_keep_days(store: MemorySqliteStore) -> None:
    """keep_days 走的是「清掉 cutoff 之前」，所以留得住的只有最近写的。"""
    # keep_days 的 cutoff 用的是库自己的时钟（真时间），所以这里不能用固定的 NOW
    now = time.time()
    store.upsert_memory(_memory("很久以前的事", occurred_at=now - 30 * 86400.0), now=now)
    store.upsert_memory(_memory("昨天的事", occurred_at=now - 86400.0), now=now)
    store.add_summary(
        char_id=CHAR,
        tier=1,
        text="阶段摘要",
        covers_from=0.0,
        covers_to=now - 40 * 86400.0,
        now=now,
    )
    deleted = store.clear_memories(CHAR, keep_days=7)
    assert deleted == 1
    remaining = [record.text for record in store.list_memories(MemoryQuery(char_id=CHAR))]
    assert remaining == ["昨天的事"]
    assert store.list_summaries(CHAR, 1, limit=10) == []
    assert store.clear_memories(CHAR) == 1
    assert store.list_memories(MemoryQuery(char_id=CHAR)) == []


def test_mark_used_updates_counter_and_timestamp(store: MemorySqliteStore) -> None:
    memory_id, _ = store.upsert_memory(_memory("用户喜欢猫"), now=NOW)
    assert store.mark_used([memory_id], now=NOW + 5) == 1
    assert store.mark_used([], now=NOW) == 0
    record = store.list_memories(MemoryQuery(char_id=CHAR))[0]
    assert record.used_count == 1
    assert record.last_used_at == pytest.approx(NOW + 5)


def test_summaries_add_latest_and_list(store: MemorySqliteStore) -> None:
    """阶梯摘要：latest_summary 取该层最新一条，list_summaries 新的在前。"""
    store.add_summary(char_id=CHAR, tier=1, text="第一段", covers_from=0.0, covers_to=10.0, now=NOW)
    store.add_summary(char_id=CHAR, tier=1, text="第二段", covers_from=10.0, covers_to=20.0, now=NOW + 1)
    store.add_summary(char_id=CHAR, tier=3, text="长期印象", covers_from=0.0, covers_to=20.0, now=NOW + 2)
    latest = store.latest_summary(CHAR, 1)
    assert latest is not None and latest.text == "第二段"
    assert [row.text for row in store.list_summaries(CHAR, 1, limit=10)] == ["第二段", "第一段"]
    assert store.list_summaries(CHAR, 2, limit=10) == []
    assert store.latest_summary(CHAR, 3) is not None


def test_messages_are_scoped_per_character(store: MemorySqliteStore) -> None:
    """两个角色的历史与记忆不能互相串味（同一张表靠 char_id 隔离）。"""
    store.add_messages([_message("amber 说的话")])
    store.add_messages(
        [
            MessageDraft(
                char_id="bella", session_id="s1", role="user", text="bella 说的话", ts=NOW
            )
        ]
    )
    assert [row.text for row in store.recent_messages(CHAR, limit=10)] == ["amber 说的话"]
    assert [row.text for row in store.recent_messages("bella", limit=10)] == ["bella 说的话"]


def test_close_is_idempotent(tmp_path: Path) -> None:
    """关两次不该抛异常（退出路径上会被调用多次）。"""
    store = open_memory_store(tmp_path / "memories.db", key=KEY)
    store.close()
    store.close()
    assert time.time() > 0
