"""文件职责：记忆知识图谱抽取测试（T2.37），不联网。"""

import json
from collections.abc import Sequence
from pathlib import Path

import pytest
from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import DiaryDraft, MemoryDraft
from services.memory_graph_service import MemoryGraphService
from services.memory_service import MemoryService

from config import LlmSettings, MemorySettings

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0
SPEC = ("https://api.example.com/v1", "k", "m", "cloud")


class FakeClient:
    def __init__(self, payload: dict[str, object]) -> None:
        self.text = json.dumps(payload, ensure_ascii=False)
        self.calls = 0

    async def stream_chat(self, messages: Sequence[dict[str, str]]):
        self.calls += 1
        for start in range(0, len(self.text), 8):
            yield self.text[start : start + 8]


class FakeLlm:
    total_timeout_s = 30.0

    def endpoint_specs(self):
        return (SPEC,)


@pytest.fixture()
def store(tmp_path: Path):
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        yield opened
    finally:
        opened.close()


@pytest.mark.asyncio
async def test_rebuild_extracts_entities_and_links(store: MemorySqliteStore) -> None:
    memory_id, _ = store.upsert_memory(
        MemoryDraft(CHAR, "fact", "用户在准备面试", 0.8, occurred_at=NOW), now=NOW
    )
    diary = store.add_diary(DiaryDraft(CHAR, "今天有点紧张", NOW), now=NOW)
    payload = {
        "entities": [
            {"name": "面试", "kind": "event", "aliases": ""},
            {"name": "用户", "kind": "person", "aliases": ""},
        ],
        "mentions": [
            {"source": f"memory:{memory_id}", "entities": ["面试", "用户"]},
            {"source": f"diary:{diary.entry_id}", "entities": ["面试"]},
        ],
        "relations": [{"from": "用户", "to": "面试", "relation": "在意"}],
    }
    client = FakeClient(payload)
    service = MemoryGraphService(
        store,
        MemorySettings(timeline_enabled=True),
        llm=FakeLlm(),  # type: ignore[arg-type]
        client_factory=lambda _endpoint: client,  # type: ignore[arg-type,return-value]
        now=lambda: NOW,
    )
    result = await service.rebuild(CHAR)
    assert result == {"entities": 2, "links": 4}
    assert {entity.name for entity in store.list_entities(CHAR)} == {"面试", "用户"}
    links = store.list_links(CHAR)
    assert any(link.from_type == "memory" and link.to_type == "entity" for link in links)
    assert any(link.relation == "在意" for link in links)

    graph = MemoryService(store, MemorySettings(timeline_enabled=True)).graph(CHAR)
    assert any(str(node["id"]).startswith("entity:") for node in graph["nodes"])
    assert any(edge["relation"] == "在意" for edge in graph["edges"])


@pytest.mark.asyncio
async def test_rebuild_without_model_does_not_clear_graph(store: MemorySqliteStore) -> None:
    store.upsert_memory(MemoryDraft(CHAR, "fact", "用户喜欢猫", 0.8, occurred_at=NOW), now=NOW)
    service = MemoryGraphService(
        store,
        MemorySettings(timeline_enabled=True),
        llm=LlmSettings(),
        now=lambda: NOW,
    )
    assert await service.rebuild(CHAR) == {"entities": 0, "links": 0}
    assert store.list_entities(CHAR) == []
