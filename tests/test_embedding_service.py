"""文件职责：EmbeddingService 的索引/查询编排单测（T2.31），不启动 Ollama。"""

from pathlib import Path

import pytest

from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from config import EmbeddingSettings
from core.memory import MemoryDraft, MessageDraft
from services.embedding_service import EmbeddingService

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0


class FakeOllama:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.attempts = 0
        self.fail = False

    async def embed(self, texts, *, timeout_s=None):
        self.attempts += 1
        if self.fail:
            raise RuntimeError("offline")
        self.calls.append(list(texts))
        return [[1.0, 0.0, 0.0] for _ in texts]

    async def status(self, *, timeout_s=None):
        return (not self.fail), ("" if not self.fail else "offline")


@pytest.fixture()
def store(tmp_path: Path) -> MemorySqliteStore:
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


def _service(store: MemorySqliteStore, fake: FakeOllama) -> EmbeddingService:
    return EmbeddingService(
        store,
        EmbeddingSettings(enabled=True, model="m1", batch_size=2),
        client_factory=lambda: fake,  # type: ignore[arg-type]
        now=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_index_pending_embeds_messages_and_facts(store: MemorySqliteStore) -> None:
    store.add_messages(
        [MessageDraft(CHAR, "s1", "user", "我养了一只猫", NOW, 7)]
    )
    store.upsert_memory(MemoryDraft(CHAR, "fact", "用户喜欢猫", 0.9, occurred_at=NOW), now=NOW)
    fake = FakeOllama()
    service = _service(store, fake)

    result = await service.index_pending(char_id=CHAR, limit=10)
    assert result["indexed"] == 2
    assert result["pending"] == 0
    assert len(fake.calls) == 1
    assert len(fake.calls[0]) == 2

    status = await service.status(char_id=CHAR)
    assert status["available"] is True
    assert status["indexed"] == 2
    assert status["pending"] == 0


@pytest.mark.asyncio
async def test_query_and_index_failures_do_not_raise(store: MemorySqliteStore) -> None:
    store.add_messages(
        [MessageDraft(CHAR, "s1", "user", "我养了一只猫", NOW, 7)]
    )
    fake = FakeOllama()
    fake.fail = True
    service = _service(store, fake)

    assert await service.embed_query("你好") is None
    result = await service.index_pending(char_id=CHAR, limit=10)
    assert result["error"] == "offline"
    status = await service.status(char_id=CHAR)
    assert status["available"] is False
    assert status["error"] == "offline"


@pytest.mark.asyncio
async def test_query_failure_cools_down_before_retrying(store: MemorySqliteStore) -> None:
    fake = FakeOllama()
    fake.fail = True
    service = _service(store, fake)

    assert await service.embed_query("第一句") is None
    assert await service.embed_query("第二句") is None
    assert fake.attempts == 1


@pytest.mark.asyncio
async def test_disabled_service_is_noop(store: MemorySqliteStore) -> None:
    fake = FakeOllama()
    service = EmbeddingService(store, EmbeddingSettings(enabled=False), client_factory=lambda: fake)  # type: ignore[arg-type]
    assert service.available is False
    assert await service.embed_query("你好") is None
    assert (await service.index_pending())["error"] == "语义检索未启用"
