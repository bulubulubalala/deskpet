"""文件职责：语义向量存储与 RRF 融合的单测（T2.31）。

不启动 Ollama：这里只测 SQLCipher 向量表、待索引扫描、失效规则和 RRF 排序；
Ollama 客户端用 httpx.MockTransport 单独测。
"""

from pathlib import Path

import pytest

from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import (
    EmbeddingSource,
    FactSnippet,
    MemoryDraft,
    MessageDraft,
    rrf_merge_facts,
)

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0


@pytest.fixture()
def store(tmp_path: Path) -> MemorySqliteStore:
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


def _message(text: str) -> MessageDraft:
    return MessageDraft(
        char_id=CHAR,
        session_id="s1",
        role="user",
        text=text,
        ts=NOW,
        token_len=len(text),
    )


def _memory(text: str, *, importance: float = 0.5) -> MemoryDraft:
    return MemoryDraft(
        char_id=CHAR,
        kind="fact",
        text=text,
        importance=importance,
        occurred_at=NOW,
    )


def test_embedding_roundtrip_pending_and_vector_search(store: MemorySqliteStore) -> None:
    message_id = store.add_messages([_message("我养了一只猫")])[0]
    memory_id, _ = store.upsert_memory(_memory("用户喜欢猫", importance=0.9), now=NOW)

    pending = store.pending_embeddings(model_id="m1", char_id=CHAR, limit=10)
    assert {(item.source_type, item.source_id) for item in pending} == {
        ("message", message_id),
        ("memory", memory_id),
    }

    store.upsert_embedding(
        EmbeddingSource("message", message_id, CHAR, "我养了一只猫", NOW),
        [1.0, 0.0, 0.0],
        model_id="m1",
        now=NOW,
    )
    store.upsert_embedding(
        EmbeddingSource("memory", memory_id, CHAR, "用户喜欢猫", NOW),
        [0.9, 0.1, 0.0],
        model_id="m1",
        now=NOW,
    )
    assert store.pending_embeddings(model_id="m1", char_id=CHAR, limit=10) == []

    hits = store.search_embeddings(
        [1.0, 0.0, 0.0],
        char_id=CHAR,
        model_id="m1",
        limit=5,
        source_types=("memory",),
    )
    assert len(hits) == 1
    assert hits[0].source_id == memory_id
    assert hits[0].kind == "fact"
    assert hits[0].importance == 0.9
    assert hits[0].score > 0.99

    indexed, pending_count = store.embedding_counts(model_id="m1", char_id=CHAR)
    assert (indexed, pending_count) == (2, 0)


def test_embedding_invalidated_on_memory_update(store: MemorySqliteStore) -> None:
    memory_id, _ = store.upsert_memory(_memory("旧记忆"), now=NOW)
    store.upsert_embedding(
        EmbeddingSource("memory", memory_id, CHAR, "旧记忆", NOW),
        [1.0, 0.0],
        model_id="m1",
        now=NOW,
    )
    assert store.pending_embeddings(model_id="m1", char_id=CHAR, limit=10) == []

    store.update_memory(memory_id, text="新记忆")
    pending = store.pending_embeddings(model_id="m1", char_id=CHAR, limit=10)
    assert [(item.source_type, item.source_id) for item in pending] == [("memory", memory_id)]
    assert store.clear_embeddings(char_id=CHAR) == 0


def test_rrf_merges_fts_and_vector_facts() -> None:
    fts = [FactSnippet(1, "fact", "全文命中", 0.5, 0.9, NOW)]
    vector = [FactSnippet(2, "fact", "向量命中", 0.5, 0.8, NOW)]
    merged = rrf_merge_facts(fts, vector, limit=2, fts_weight=0.35, vector_weight=0.65)
    assert [item.memory_id for item in merged] == [2, 1]
