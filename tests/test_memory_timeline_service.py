"""文件职责：时间金字塔生成服务测试（T2.33），不联网。"""

from collections.abc import Sequence
from pathlib import Path

import pytest
from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import MessageDraft
from services.memory_timeline_service import MemoryTimelineService

from config import MemorySettings

KEY = bytes(range(1, 33))
CHAR = "xiaoyu"
NOW = 1_700_000_000.0
SPEC = ("https://api.example.com/v1", "k", "m", "cloud")


class FakeClient:
    def __init__(self, text: str = "情景摘要") -> None:
        self.text = text
        self.calls: list[list[dict[str, str]]] = []

    async def stream_chat(self, messages: Sequence[dict[str, str]]):
        self.calls.append([dict(message) for message in messages])
        for start in range(0, len(self.text), 4):
            yield self.text[start : start + 4]


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


def _service(store: MemorySqliteStore, client: FakeClient) -> MemoryTimelineService:
    return MemoryTimelineService(
        store,
        MemorySettings(timeline_enabled=True),
        llm=FakeLlm(),  # type: ignore[arg-type]
        client_factory=lambda _endpoint: client,  # type: ignore[arg-type,return-value]
        now=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_consolidate_builds_episode_day_week_month(store: MemorySqliteStore) -> None:
    store.add_messages(
        [
            MessageDraft(CHAR, "s1", "user", "今天面试完了", NOW, 5),
            MessageDraft(CHAR, "s1", "assistant", "感觉怎么样？", NOW + 10, 4),
            MessageDraft(CHAR, "s1", "user", "有点累，但还行", NOW + 20, 6),
        ]
    )
    client = FakeClient()
    created = await _service(store, client).consolidate(CHAR, now=NOW + 30)

    assert created == {"episode": 1, "day": 1, "week": 1, "month": 1}
    periods = store.list_periods(CHAR, limit=10)
    assert {period.level for period in periods} == {"episode", "day", "week", "month"}
    episode = next(period for period in periods if period.level == "episode")
    assert episode.summary == "情景摘要"
    assert store.period_sources(episode.period_id) == [
        ("message", row.message_id)
        for row in store.messages_between(CHAR, start=NOW, end=NOW + 100)
    ]
    day = next(period for period in periods if period.level == "day")
    assert day.day_key != ""
    assert len(client.calls) == 4


@pytest.mark.asyncio
async def test_backfill_processes_old_messages(store: MemorySqliteStore) -> None:
    old = NOW - 40 * 86400
    store.add_messages(
        [
            MessageDraft(CHAR, "old", "user", "很久以前聊过面试", old, 7),
            MessageDraft(CHAR, "old", "assistant", "后来怎么样了？", old + 10, 6),
            MessageDraft(CHAR, "s1", "user", "今天下雨了", NOW, 5),
            MessageDraft(CHAR, "s1", "assistant", "带伞了吗？", NOW + 10, 5),
        ]
    )
    client = FakeClient()
    result = await _service(store, client).backfill(CHAR, days=90, now=NOW + 30)
    assert result["episode"] >= 2
    periods = store.list_periods(CHAR, levels=("episode",), limit=10)
    assert any(period.period_start < NOW - 30 * 86400 for period in periods)


@pytest.mark.asyncio
async def test_second_consolidate_is_idempotent(store: MemorySqliteStore) -> None:
    store.add_messages(
        [
            MessageDraft(CHAR, "s1", "user", "今天面试完了", NOW, 5),
            MessageDraft(CHAR, "s1", "assistant", "感觉怎么样？", NOW + 10, 4),
        ]
    )
    client = FakeClient()
    service = _service(store, client)
    await service.consolidate(CHAR, now=NOW + 30)
    calls = len(client.calls)
    again = await service.consolidate(CHAR, now=NOW + 60)
    assert again == {"episode": 0, "day": 0, "week": 0, "month": 0}
    assert len(client.calls) == calls


@pytest.mark.asyncio
async def test_gap_creates_two_episodes(store: MemorySqliteStore) -> None:
    store.add_messages(
        [
            MessageDraft(CHAR, "s1", "user", "早上好", NOW, 3),
            MessageDraft(CHAR, "s1", "assistant", "早呀", NOW + 10, 2),
            MessageDraft(CHAR, "s1", "user", "晚上见", NOW + 3600, 3),
            MessageDraft(CHAR, "s1", "assistant", "晚上见", NOW + 3610, 3),
        ]
    )
    client = FakeClient()
    created = await _service(store, client).consolidate(CHAR, now=NOW + 4000)
    assert created["episode"] == 2
