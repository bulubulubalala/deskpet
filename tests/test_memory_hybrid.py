"""文件职责：MemoryService 的 FTS + 向量 RRF 召回单测（T2.31），不联网。"""

from pathlib import Path

import pytest

from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from config import MemorySettings
from core.memory import EmbeddingSource, MemoryDraft, RecallQuery
from services.memory_service import MemoryService

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0


class FakeEmbedding:
    model = "m1"

    async def embed_query(self, _query: str) -> list[float]:
        return [1.0, 0.0, 0.0]

    async def status(self, *, char_id: str = "") -> dict[str, object]:
        return {"enabled": True, "available": True, "model": "m1", "error": ""}

    async def index_pending(self, *, char_id: str = "", limit: int = 200) -> dict[str, object]:
        return {"indexed": 0, "pending": 0, "error": ""}


@pytest.fixture()
def store(tmp_path: Path) -> MemorySqliteStore:
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


def _memory(store: MemorySqliteStore, text: str) -> int:
    memory_id, _ = store.upsert_memory(
        MemoryDraft(CHAR, "fact", text, 0.8, occurred_at=NOW), now=NOW
    )
    store.upsert_embedding(
        EmbeddingSource("memory", memory_id, CHAR, text, NOW),
        [1.0, 0.0, 0.0],
        model_id="m1",
        now=NOW,
    )
    return memory_id


def test_recall_includes_vector_only_fact(store: MemorySqliteStore) -> None:
    memory_id = _memory(store, "用户喜欢在雨天听爵士")
    service = MemoryService(
        store,
        MemorySettings(recall_limit=5),
        now=lambda: NOW,
    )
    service.attach_embedding(FakeEmbedding(), model="m1")

    context = service.recall(
        char_id=CHAR,
        query="完全不包含原文任何词",
        now=NOW,
        query_vector=[1.0, 0.0, 0.0],
    )

    assert [fact.memory_id for fact in context.facts] == [memory_id]


def test_search_hybrid_returns_vector_only_fact(store: MemorySqliteStore) -> None:
    memory_id = _memory(store, "用户喜欢在雨天听爵士")
    service = MemoryService(store, MemorySettings(), now=lambda: NOW)
    service.attach_embedding(FakeEmbedding(), model="m1")

    hits = service.search(
        RecallQuery(char_id=CHAR, query="完全无关的查询", now=NOW),
        query_vector=[1.0, 0.0, 0.0],
    )

    assert [hit.memory_id for hit in hits] == [memory_id]


@pytest.mark.asyncio
async def test_embed_query_delegates_and_handles_failure(store: MemorySqliteStore) -> None:
    service = MemoryService(store, MemorySettings(), now=lambda: NOW)

    class Broken:
        async def embed_query(self, _query: str) -> list[float]:
            raise RuntimeError("offline")

    service.attach_embedding(Broken(), model="m1")
    assert await service.embed_query("你好") is None
