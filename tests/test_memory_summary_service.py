"""文件职责：单测 services/memory_summary_service.py 的阶梯压缩（需求 §6.4 / F3 验收 2）。

依赖方向：tests -> services / config / core；不联网（假客户端 + 假记忆库）。
谁调用：pytest。

这里只检验「什么时候压、压什么、压坏了怎么办」：真实模型的摘要质量由 T2.2 的实测覆盖。
"""

import asyncio
from collections.abc import Sequence
from dataclasses import replace
from typing import cast

from config import LlmSettings, MemorySettings, Settings
from core.memory import MemoryBackendError, MessageRow, SummarySnippet
from services.memory_summary_service import MemorySummarizer, build_memory_summarizer

CHAR = "amber"
NOW = 1_700_000_000.0
SPEC = ("https://api.example.com/v1", "k", "m", "cloud")


class FakeClient:
    """按脚本吐文本的假模型客户端；error 用来复现限流 / 超时。"""

    def __init__(self, text: str = "摘要正文", *, error: Exception | None = None) -> None:
        self.text = text
        self.error = error
        self.calls: list[list[dict[str, str]]] = []

    async def stream_chat(self, messages: Sequence[dict[str, str]]) -> object:
        self.calls.append([dict(message) for message in messages])
        if self.error is not None:
            raise self.error
        for start in range(0, len(self.text), 5):
            yield self.text[start : start + 5]


class FakeLlm:
    """只提供压缩器要的两样东西：端点顺序与总超时。"""

    total_timeout_s = 30.0

    def __init__(self, specs: Sequence[tuple[str, str, str, str]] = (SPEC,)) -> None:
        self._specs = list(specs)

    def endpoint_specs(self) -> tuple[tuple[str, str, str, str], ...]:
        return tuple(self._specs)


class FakeStore:
    """假记忆库：只实现压缩器用到的方法，并记下每次写入。"""

    def __init__(
        self, *, messages: Sequence[MessageRow] = (), summaries: dict | None = None
    ) -> None:
        self.messages = list(messages)
        self.summaries: dict[int, list[SummarySnippet]] = summaries or {1: [], 2: [], 3: []}
        self.added: list[dict] = []
        self.covered: list[tuple[list[int], int]] = []
        self.archived: list[tuple[list[int], float]] = []
        self.fail_write = False
        self._next_id = 100

    def uncovered_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        if self.fail_write:
            raise MemoryBackendError("库炸了")
        return self.messages[:limit]

    def latest_summary(self, char_id: str, tier: int) -> SummarySnippet | None:
        rows = self.summaries.get(tier, [])
        return rows[-1] if rows else None

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        return list(reversed(self.summaries.get(tier, [])))[:limit]

    def add_summary(
        self,
        *,
        char_id: str,
        tier: int,
        text: str,
        covers_from: float,
        covers_to: float,
        source_ids: str = "",
        now: float = 0.0,
    ) -> int:
        if self.fail_write:
            raise MemoryBackendError("写不进去")
        self._next_id += 1
        record = {
            "id": self._next_id,
            "char_id": char_id,
            "tier": tier,
            "text": text,
            "covers_from": covers_from,
            "covers_to": covers_to,
            "source_ids": source_ids,
        }
        self.added.append(record)
        self.summaries.setdefault(tier, []).append(
            SummarySnippet(
                summary_id=self._next_id,
                tier=tier,
                text=text,
                covers_to=covers_to,
                source_ids=source_ids,
            )
        )
        return self._next_id

    def mark_covered(self, message_ids: Sequence[int], *, summary_id: int) -> int:
        self.covered.append((list(message_ids), summary_id))
        return len(message_ids)

    def mark_summaries_archived(self, summary_ids: Sequence[int], *, now: float) -> int:
        self.archived.append((list(summary_ids), now))
        return len(summary_ids)


def _row(
    message_id: int, text: str, *, ts: float = NOW, token_len: int | None = None
) -> MessageRow:
    return MessageRow(
        message_id=message_id,
        char_id=CHAR,
        session_id="s1",
        role="user",
        text=text,
        ts=ts,
        token_len=len(text) if token_len is None else token_len,
    )


def _summary(
    summary_id: int, tier: int, text: str, *, covers_to: float = NOW, source_ids: str = ""
) -> SummarySnippet:
    return SummarySnippet(
        summary_id=summary_id,
        tier=tier,
        text=text,
        covers_to=covers_to,
        source_ids=source_ids,
    )


def _settings(**overrides: object) -> MemorySettings:
    base: dict[str, object] = {"summary_trigger_messages": 3, "summary_trigger_tokens": 0}
    base.update(overrides)
    return replace(MemorySettings(), **base)  # type: ignore[arg-type]


def _build(
    store: FakeStore | None,
    *,
    client: FakeClient | None = None,
    settings: MemorySettings | None = None,
    llm: FakeLlm | None = None,
    now: float = NOW,
) -> tuple[MemorySummarizer, FakeClient]:
    client = client or FakeClient()
    summarizer = MemorySummarizer(
        cast(object, store),  # type: ignore[arg-type]
        settings or _settings(),
        llm=cast(LlmSettings, llm or FakeLlm()),
        client_factory=cast(object, lambda _endpoint: client),  # type: ignore[arg-type]
        now=lambda: now,
    )
    return summarizer, client


# ---- L1：原文 → 阶段摘要 ----


async def test_below_threshold_does_nothing() -> None:
    """没到条数阈值：一条不压，也不叫模型。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙")])
    summarizer, client = _build(store)
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []
    assert client.calls == []


async def test_l1_summary_covers_batch_and_wraps_untrusted() -> None:
    """到阈值：写一条 L1（记住来源消息与时间跨度），并把原文标记为已覆盖。"""
    store = FakeStore(
        messages=[_row(1, "甲", ts=10.0), _row(2, "乙", ts=20.0), _row(3, "丙", ts=30.0)]
    )
    summarizer, client = _build(store)
    assert await summarizer.compress(CHAR) == 1
    assert len(store.added) == 1
    added = store.added[0]
    assert added["tier"] == 1
    assert added["covers_from"] == 10.0
    assert added["covers_to"] == 30.0
    assert added["source_ids"] == "1,2,3"
    assert store.covered == [([1, 2, 3], added["id"])]
    # 原文必须裹成不可信输入（§7.4），提示词里带上「只做归纳」
    prompt = client.calls[0][1]["content"]
    assert "<untrusted_input>" in prompt
    assert "压缩成摘要" in prompt


async def test_token_threshold_triggers_below_message_threshold() -> None:
    """条数没到但估算 token 越线，也要压。"""
    store = FakeStore(messages=[_row(1, "甲" * 6, token_len=6), _row(2, "乙" * 6, token_len=6)])
    summarizer, _client = _build(
        store, settings=_settings(summary_trigger_messages=0, summary_trigger_tokens=10)
    )
    assert await summarizer.compress(CHAR) == 1


async def test_both_thresholds_zero_disables_compression() -> None:
    """两个阈值都为 0 = 用户关掉了阶梯压缩。"""
    store = FakeStore(messages=[_row(i, "话") for i in range(1, 50)])
    summarizer, _client = _build(
        store, settings=_settings(summary_trigger_messages=0, summary_trigger_tokens=0)
    )
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []


async def test_truncates_overlong_summary() -> None:
    """模型话太多：摘要被截到预算量级，原文不会被整段存进库。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(
        store, client=FakeClient("很" * 300), settings=_settings(l1_budget_tokens=10)
    )
    assert await summarizer.compress(CHAR) == 1
    text = store.added[0]["text"]
    assert len(text) < 300
    assert text.endswith("…")


async def test_empty_model_output_writes_nothing() -> None:
    """模型一声不吭（例如只吐了思维链）：不写空摘要，下次再试。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(store, client=FakeClient(""))
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []
    assert store.covered == []


async def test_model_failure_is_swallowed() -> None:
    """限流 / 超时 / 断网：压缩放弃这一批，绝不冒泡（记忆是增强项）。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(store, client=FakeClient(error=RuntimeError("boom")))
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []


async def test_no_model_configured_skips_quietly() -> None:
    """一个端点都没配：安静跳过，不假装压过了。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(store, llm=FakeLlm(specs=()))
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []


async def test_store_failure_is_swallowed() -> None:
    """库写失败：这一批不做，也不把异常抛回后台任务。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    store.fail_write = True
    summarizer, _client = _build(store)
    assert await summarizer.compress(CHAR) == 0


# ---- L2 / L3：向上聚合 ----


async def test_l2_aggregates_three_l1() -> None:
    """攒够 3 条 L1：聚成一条 L2，来源写成下层摘要 id。"""
    store = FakeStore(
        summaries={
            1: [
                _summary(1, 1, "甲", covers_to=10.0),
                _summary(2, 1, "乙", covers_to=20.0),
                _summary(3, 1, "丙", covers_to=30.0),
            ],
            2: [],
            3: [],
        }
    )
    summarizer, _client = _build(
        store, settings=_settings(summary_trigger_messages=3, summary_trigger_tokens=0)
    )
    assert await summarizer.compress(CHAR) == 1
    added = store.added[0]
    assert added["tier"] == 2
    assert added["source_ids"] == "1,2,3"
    assert added["covers_to"] == 30.0


async def test_l2_skips_already_aggregated_l1() -> None:
    """已经聚过的 L1 不再重复聚：只剩第 4 条时不到阈值，什么都不做。"""
    store = FakeStore(
        summaries={
            1: [
                _summary(1, 1, "甲"),
                _summary(2, 1, "乙"),
                _summary(3, 1, "丙"),
                _summary(4, 1, "丁"),
            ],
            2: [_summary(9, 2, "旧的梗概", source_ids="1,2,3")],
            3: [],
        }
    )
    summarizer, _client = _build(store, settings=_settings(l1_aggregate_summaries=3))
    assert await summarizer.compress(CHAR) == 0
    assert store.added == []


async def test_l3_needs_three_l2() -> None:
    """3 条 L2 归纳出一条 L3 长期印象。"""
    store = FakeStore(
        summaries={
            1: [],
            2: [
                _summary(11, 2, "梗概一", covers_to=10.0),
                _summary(12, 2, "梗概二", covers_to=20.0),
                _summary(13, 2, "梗概三", covers_to=30.0),
            ],
            3: [],
        }
    )
    summarizer, _client = _build(store, settings=_settings(l2_aggregate_summaries=3))
    assert await summarizer.compress(CHAR) == 1
    added = store.added[0]
    assert added["tier"] == 3
    assert added["source_ids"] == "11,12,13"


async def test_l3_replaces_by_latest_only_when_three_more_arrive() -> None:
    """已有 L3（聚合到 13）：再来两条不够，第三条才归纳出新的一版。"""
    store = FakeStore(
        summaries={
            1: [],
            2: [
                _summary(11, 2, "梗概一"),
                _summary(12, 2, "梗概二"),
                _summary(13, 2, "梗概三"),
                _summary(14, 2, "梗概四"),
            ],
            3: [_summary(20, 3, "旧印象", source_ids="11,12,13")],
        }
    )
    summarizer, _client = _build(store, settings=_settings(l2_aggregate_summaries=3))
    assert await summarizer.compress(CHAR) == 0
    # 直接补到 3 条未聚合的 L2（14 已经有了，再加 15、16）
    store.summaries[2].append(_summary(15, 2, "梗概五"))
    store.summaries[2].append(_summary(16, 2, "梗概六"))
    assert await summarizer.compress(CHAR) == 1
    assert store.added[-1]["source_ids"] == "14,15,16"


# ---- 调度与降级 ----


async def test_schedule_runs_in_background() -> None:
    """schedule 只排队：调用后立刻返回，任务自己跑完。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(store)
    summarizer.schedule(CHAR)
    assert store.added == []  # 还没轮到它跑
    for _ in range(5):
        await asyncio.sleep(0)
    assert len(store.added) == 1


async def test_schedule_twice_runs_once() -> None:
    """同一个角色压缩还没跑完时再排一次：直接跳过，不排队。"""
    store = FakeStore(messages=[_row(1, "甲"), _row(2, "乙"), _row(3, "丙")])
    summarizer, _client = _build(store)
    summarizer.schedule(CHAR)
    summarizer.schedule(CHAR)
    for _ in range(5):
        await asyncio.sleep(0)
    assert len(store.added) == 1


def test_schedule_without_event_loop_is_noop() -> None:
    """在同步上下文（没有事件循环）里调用 schedule 也不能炸。"""
    store = FakeStore(messages=[_row(1, "甲")])
    summarizer, _client = _build(store)
    summarizer.schedule(CHAR)
    assert store.added == []


async def test_unavailable_store_is_a_quiet_noop() -> None:
    """库没打开（None）：available=False，compress 与 schedule 都安静跳过。"""
    summarizer, _client = _build(None)
    assert summarizer.available is False
    assert await summarizer.compress(CHAR) == 0
    summarizer.schedule(CHAR)


def test_build_memory_summarizer_marks_availability() -> None:
    """组合根构造器：store=None 时仍然构造得出来，只是不可用（§6.4 降级）。"""
    summarizer = build_memory_summarizer(Settings(), None)
    assert summarizer.available is False
