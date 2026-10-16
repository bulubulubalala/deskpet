"""文件职责：记忆用例层（services/memory_service.py）的行为测试（需求 §6.4；PLAN T2.1a）。

依赖方向：tests -> services.memory_service / core.memory / config；用假记忆库（FakeStore）驱动，
不碰 SQLCipher、不碰 Windows DPAPI。
测试重点：预算裁剪优先级、失败降级（读失败=没记忆、写失败=只记日志）、管理端点的 DP-MEM-* 映射。
谁调用：pytest。
"""

from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import pytest

from config import MEMORY_KEY_NAME, MemorySettings, Settings
from contracts.errors import (
    CODE_MEM_INDEX_BROKEN,
    CODE_MEM_KEY_INVALID,
    CODE_MEM_READONLY_FALLBACK,
)
from contracts.health import ModuleState
from core.env_events import EVENT_MEM_KEY_INVALID, EVENT_MEM_READONLY
from core.errors import MemoryStoreError
from core.memory import (
    FactSnippet,
    MemoryDraft,
    MemoryIndexBrokenError,
    MemoryKeyInvalidError,
    MemoryQuery,
    MemoryReadonlyError,
    MessageDraft,
    MessageRow,
    MemoryBackendError,
    MemoryRecord,
    RecallQuery,
    SummarySnippet,
)
from services.memory_service import MemoryService, build_memory_service

CHAR = "amber"
NOW = 1_700_000_000.0
#: 10 个汉字的句子：estimate_tokens 按「CJK 每字 1」算，正好 10 token
TEN_TOKENS = "这是一句十个汉字的话"


def _fact(memory_id: int, text: str, *, importance: float = 0.5) -> FactSnippet:
    return FactSnippet(
        memory_id=memory_id,
        kind="fact",
        text=text,
        importance=importance,
        score=1.0,
        occurred_at=NOW,
    )


def _summary(summary_id: int, tier: int, text: str) -> SummarySnippet:
    return SummarySnippet(summary_id=summary_id, tier=tier, text=text, covers_to=NOW)


def _observation(memory_id: int, text: str) -> MemoryRecord:
    """行为观察在库里就是一条 kind=action 的记忆（T2.1c）。"""
    return MemoryRecord(
        memory_id=memory_id,
        char_id=CHAR,
        kind="action",
        tier="fact",
        text=text,
        importance=0.4,
        created_at=NOW,
        last_used_at=None,
        used_count=0,
        source_msg_ids="",
    )


def _row(message_id: int, text: str, *, role: str = "user") -> MessageRow:
    return MessageRow(
        message_id=message_id,
        char_id=CHAR,
        session_id="s1",
        role=role,  # type: ignore[arg-type]
        text=text,
        ts=NOW,
        token_len=len(text),
    )


class FakeStore:
    """可编程的假记忆库：喂数据验证「取什么 / 裁什么」，按需制造故障。"""

    def __init__(
        self,
        *,
        impression: SummarySnippet | None = None,
        episodes: Sequence[SummarySnippet] = (),
        summaries: Sequence[SummarySnippet] = (),
        facts: Sequence[FactSnippet] = (),
        observations: Sequence[MemoryRecord] = (),
        history: Sequence[MessageRow] = (),
    ) -> None:
        self.impression = impression
        self.episodes = list(episodes)
        self.summaries = list(summaries)
        self.facts = list(facts)
        self.observations = list(observations)
        self.history = list(history)
        self.recall_queries: list[RecallQuery] = []
        self.error: MemoryBackendError | None = None
        self.calls: list[str] = []
        self.used: list[tuple[list[int], float]] = []
        self.messages: list[MessageDraft] = []
        self.upserted: list[MemoryDraft] = []
        self.upserted_now: list[float] = []
        self.cleared: list[tuple[str, float | None]] = []
        self.deleted: list[int] = []

    def _check(self, name: str) -> None:
        self.calls.append(name)
        if self.error is not None:
            raise self.error

    # ---- 取数 ----
    def latest_summary(self, char_id: str, tier: int) -> SummarySnippet | None:
        self._check("latest_summary")
        return self.impression if tier == 3 else None

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        self._check("list_summaries")
        source = self.episodes if tier == 2 else self.summaries
        return list(source)[:limit]

    def search_memories(self, query: RecallQuery) -> list[FactSnippet]:
        self._check("search_memories")
        self.recall_queries.append(query)
        return list(self.facts)[: query.limit]

    def recent_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        self._check("recent_messages")
        return list(self.history)[:limit]

    def mark_used(self, memory_ids: Sequence[int], *, now: float) -> int:
        self._check("mark_used")
        self.used.append((list(memory_ids), now))
        return len(memory_ids)

    # ---- 写 ----
    def add_messages(self, drafts: Sequence[MessageDraft]) -> tuple[int, ...]:
        self._check("add_messages")
        self.messages.extend(drafts)
        return tuple(range(len(self.messages)))

    def upsert_memory(self, draft: MemoryDraft, *, now: float) -> tuple[int, bool]:
        self._check("upsert_memory")
        self.upserted.append(draft)
        self.upserted_now.append(now)
        return len(self.upserted), False

    def list_memories(self, query: MemoryQuery) -> list[object]:
        self._check("list_memories")
        if query.kind == "action":
            return list(self.observations)[: query.limit]
        return []

    def delete_memory(self, memory_id: int) -> bool:
        self._check("delete_memory")
        self.deleted.append(memory_id)
        return True

    def clear_memories(self, char_id: str, *, keep_days: float | None = None) -> int:
        self._check("clear_memories")
        self.cleared.append((char_id, keep_days))
        return 3


class FakeEnv:
    """假环境事件总线：只记下上报了什么，用来验证 A/B 级事件确实发出去了。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, str]] = []

    def report(
        self,
        event_id: str,
        *,
        fact: str,
        user_hint: str = "",
        level: str | None = None,
        dedup_key: str | None = None,
        ttl_s: float | None = None,
    ) -> None:
        self.events.append((event_id, fact, user_hint))

    def clear(self, *, dedup_key: str | None = None, event_id: str | None = None) -> int:
        return 0


def _service(
    store: FakeStore | None,
    *,
    env: FakeEnv | None = None,
    startup_error: MemoryBackendError | None = None,
    **overrides: int,
) -> MemoryService:
    settings = replace(MemorySettings(), **overrides) if overrides else MemorySettings()
    return MemoryService(store, settings, env=env, startup_error=startup_error, now=lambda: NOW)


# ---------------------------------------------------------------- 模块状态


def test_module_state_is_ready_when_store_is_available() -> None:
    service = _service(FakeStore())
    assert service.available is True
    assert service.module_state() == (ModuleState.READY, None)


def test_module_state_is_unavailable_without_store() -> None:
    service = _service(None)
    assert service.available is False
    assert service.module_state() == (ModuleState.ERROR, "unavailable")


@pytest.mark.parametrize(
    ("error", "detail"),
    [
        (MemoryKeyInvalidError("密钥不对"), "key_invalid"),
        (MemoryReadonlyError("只读"), "readonly"),
        (MemoryIndexBrokenError("索引坏了"), "index_broken"),
    ],
)
def test_module_state_reports_startup_fault_detail(error: MemoryBackendError, detail: str) -> None:
    """启动就打不开时，/health 必须给出机器可读的原因（设置界面据此解释）。"""
    service = _service(None, startup_error=error)
    assert service.module_state() == (ModuleState.ERROR, detail)
    assert service.startup_error is error


def test_runtime_fault_marks_module_error() -> None:
    """运行期出过结构性故障后不能再谎报 ready（否则设置界面会显示一切正常）。"""
    store = FakeStore()
    service = _service(store)
    assert service.module_state()[0] is ModuleState.READY
    store.error = MemoryReadonlyError("只读")
    assert service.recall(char_id=CHAR, query="猫", now=NOW).is_empty
    assert service.module_state() == (ModuleState.ERROR, "readonly")


# ---------------------------------------------------------------- 对话链路：记录


def test_record_message_skips_blank_and_missing_store() -> None:
    assert (
        _service(None).record_message(
            char_id=CHAR, session_id="s1", role="user", text="你好", ts=NOW
        )
        is None
    )
    store = FakeStore()
    service = _service(store)
    service.record_message(char_id=CHAR, session_id="s1", role="user", text="   ", ts=NOW)
    assert store.messages == []
    service.record_message(char_id=CHAR, session_id="s1", role="user", text=" 你好 ", ts=NOW)
    assert len(store.messages) == 1
    assert store.messages[0].text == "你好", "落库前要去掉首尾空白"
    assert store.messages[0].token_len > 0


def test_record_message_degrades_on_readonly() -> None:
    """写失败绝不能让这轮对话崩：只降级 + 上报 mem.readonly。"""
    env = FakeEnv()
    store = FakeStore()
    store.error = MemoryReadonlyError("数据目录只读")
    service = _service(store, env=env)
    service.record_message(char_id=CHAR, session_id="s1", role="user", text="你好", ts=NOW)
    assert env.events and env.events[0][0] == EVENT_MEM_READONLY
    assert service.module_state() == (ModuleState.ERROR, "readonly")


def test_record_facts_fills_char_id_and_occurred_at() -> None:
    store = FakeStore()
    service = _service(store)
    ids = service.record_facts(
        char_id=CHAR,
        session_id="s1",
        facts=[MemoryDraft(char_id="", kind="fact", text=" 用户养了一只猫 ")],
        ts=NOW,
    )
    assert ids == [1]
    assert store.upserted[0].char_id == CHAR
    assert store.upserted[0].occurred_at == NOW
    assert store.upserted[0].text == "用户养了一只猫"
    assert store.upserted_now == [NOW]


def test_record_facts_skips_blank_and_reports_key_invalid() -> None:
    env = FakeEnv()
    store = FakeStore()
    service = _service(store, env=env)
    assert (
        service.record_facts(
            char_id=CHAR,
            session_id="s1",
            facts=[MemoryDraft(char_id="", kind="fact", text="   ")],
            ts=NOW,
        )
        == []
    )
    assert store.upserted == []
    store.error = MemoryKeyInvalidError("密钥不对")
    assert (
        service.record_facts(
            char_id=CHAR,
            session_id="s1",
            facts=[MemoryDraft(char_id="", kind="fact", text="猫")],
            ts=NOW,
        )
        == []
    )
    assert env.events[0][0] == EVENT_MEM_KEY_INVALID


# ---------------------------------------------------------------- 对话链路：检索与预算


def test_recall_keeps_every_layer_when_budgets_allow() -> None:
    store = FakeStore(
        impression=_summary(9, 3, "用户是长期养猫的人"),
        episodes=[_summary(2, 2, "上一周聊了工作")],
        summaries=[_summary(1, 1, "昨天聊了电影")],
        facts=[_fact(5, "用户喜欢猫")],
        history=[_row(1, "你好"), _row(2, "今天聊什么", role="assistant")],
    )
    context = _service(store).recall(char_id=CHAR, query="猫", now=NOW)
    assert context.is_empty is False
    assert context.impressions == "用户是长期养猫的人"
    assert context.episodes == ("上一周聊了工作",)
    assert context.summaries == ("昨天聊了电影",)
    assert [fact.memory_id for fact in context.facts] == [5]
    assert [(turn.role, turn.text) for turn in context.history] == [
        ("user", "你好"),
        ("assistant", "今天聊什么"),
    ]
    assert context.dropped == ()
    assert context.tokens > 0


def test_recall_drops_history_then_l0_then_l1_then_l2() -> None:
    """预算不够时的裁剪顺序是固定的：历史最先丢、L2 最后丢（§6.4）。"""
    store = FakeStore(
        episodes=[_summary(2, 2, TEN_TOKENS), _summary(3, 2, TEN_TOKENS)],
        summaries=[_summary(1, 1, TEN_TOKENS), _summary(4, 1, TEN_TOKENS)],
        facts=[_fact(5, TEN_TOKENS), _fact(6, TEN_TOKENS)],
        history=[_row(1, TEN_TOKENS), _row(2, TEN_TOKENS), _row(3, TEN_TOKENS)],
    )
    service = _service(
        store,
        l2_budget_tokens=10,
        l1_budget_tokens=10,
        recall_budget_tokens=10,
        history_budget_tokens=10,
    )
    context = service.recall(char_id=CHAR, query="话", now=NOW)
    assert context.dropped == ("l2", "l1", "l0", "history")
    assert len(context.episodes) == 1
    assert len(context.summaries) == 1
    assert len(context.facts) == 1
    assert len(context.history) == 1
    assert context.history[-1].text == TEN_TOKENS, "历史保留的是最新那条"


def test_recall_truncates_l3_instead_of_dropping_it() -> None:
    """L3（长期印象）是唯一「只截断不整层丢」的层——它是人设连续性的锚。"""
    store = FakeStore(impression=_summary(9, 3, TEN_TOKENS))
    context = _service(store, l3_budget_tokens=4).recall(char_id=CHAR, query="", now=NOW)
    assert context.impressions.endswith("…")
    assert 0 < len(context.impressions) < len(TEN_TOKENS)
    assert "l3" not in context.dropped


def test_recall_marks_injected_facts_as_used() -> None:
    store = FakeStore(facts=[_fact(5, "用户喜欢猫"), _fact(6, "用户在上海")])
    context = _service(store).recall(char_id=CHAR, query="猫", now=NOW)
    assert context.injected_ids == (5, 6)
    assert store.used == [([5, 6], NOW)]


def test_recall_injects_observations_separately_from_facts() -> None:
    """行为观察（T2.1c）单独成段、单独算预算，也不占用户事实的检索名额。"""
    store = FakeStore(
        facts=[_fact(5, "用户喜欢猫")],
        observations=[_observation(11, "他经常在你话说到一半的时候打断你。")],
    )
    context = _service(store).recall(char_id=CHAR, query="猫", now=NOW)

    assert [fact.memory_id for fact in context.facts] == [5]
    assert [item.text for item in context.observations] == ["他经常在你话说到一半的时候打断你。"]
    assert context.injected_ids == (5, 11), "观察注入过也要记 used_count"
    assert store.recall_queries[0].exclude_kinds == ("action",)


def test_recall_drops_observations_before_facts() -> None:
    store = FakeStore(
        facts=[_fact(5, TEN_TOKENS), _fact(6, TEN_TOKENS)],
        observations=[_observation(11, TEN_TOKENS), _observation(12, TEN_TOKENS)],
    )
    service = _service(store, observation_budget_tokens=10, recall_budget_tokens=10)
    context = service.recall(char_id=CHAR, query="话", now=NOW)

    assert context.dropped == ("observation", "l0"), "观察比用户事实先让位"
    assert len(context.observations) == 1
    assert len(context.facts) == 1


def test_recall_skips_observations_when_budget_is_zero() -> None:
    """观察预算写 0 = 这一层完全不注入，连库都不该去查。"""
    store = FakeStore(observations=[_observation(11, "他经常打断你。")])
    context = _service(store, observation_budget_tokens=0).recall(char_id=CHAR, query="", now=NOW)
    assert context.observations == ()
    assert "list_memories" not in store.calls


def test_recall_respects_zero_budgets_and_turn_limits() -> None:
    """配置里某一层写 0 = 这一层完全不注入，连库都不该去查。"""
    store = FakeStore(facts=[_fact(5, "用户喜欢猫")], history=[_row(1, "你好")])
    service = _service(store, recall_limit=0, history_turns=0)
    context = service.recall(char_id=CHAR, query="猫", now=NOW)
    assert context.is_empty
    assert "search_memories" not in store.calls
    assert "recent_messages" not in store.calls
    assert store.used == []


def test_recall_degrades_to_empty_on_index_failure() -> None:
    store = FakeStore(facts=[_fact(5, "用户喜欢猫")])
    store.error = MemoryIndexBrokenError("索引坏了")
    context = _service(store).recall(char_id=CHAR, query="猫", now=NOW)
    assert context.is_empty
    assert context.injected_ids == ()


# ---------------------------------------------------------------- 管理端点：错误必须可见


def test_manage_endpoints_require_store() -> None:
    """store=None 且没有启动异常时，管理端点仍要给出一个 DP-MEM-* 而不是空指针。"""
    service = _service(None)
    with pytest.raises(MemoryStoreError) as info:
        service.search(RecallQuery(char_id=CHAR, query="猫"))
    assert info.value.code == CODE_MEM_INDEX_BROKEN


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (MemoryKeyInvalidError("密钥不对"), CODE_MEM_KEY_INVALID),
        (MemoryReadonlyError("只读"), CODE_MEM_READONLY_FALLBACK),
        (MemoryIndexBrokenError("索引坏了"), CODE_MEM_INDEX_BROKEN),
    ],
)
def test_manage_endpoints_map_adapter_errors(error: MemoryBackendError, code: str) -> None:
    store = FakeStore()
    store.error = error
    service = _service(store)
    with pytest.raises(MemoryStoreError) as info:
        service.search(RecallQuery(char_id=CHAR, query="猫"))
    assert info.value.code == code
    assert info.value.user_hint, "每个 DP-MEM-* 都要有给用户看的下一步"


def test_manage_endpoints_still_work_when_store_is_healthy() -> None:
    store = FakeStore()
    service = _service(store)
    assert service.list_memories(MemoryQuery(char_id=CHAR)) == []
    assert service.delete(7) is True
    assert service.clear(CHAR, keep_days=7.0) == 3
    assert store.deleted == [7]
    assert store.cleared == [(CHAR, 7.0)]


def test_remember_rejects_blank_text() -> None:
    store = FakeStore()
    service = _service(store)
    with pytest.raises(MemoryStoreError) as info:
        service.remember(MemoryDraft(char_id=CHAR, kind="fact", text="   "))
    assert info.value.code == CODE_MEM_INDEX_BROKEN
    assert store.upserted == [], "空记忆不该写库"


def test_remember_uses_current_time_when_now_is_zero() -> None:
    """now=0 是「用现在」而不是「1970 年」：否则时间衰减与排序全错。"""
    store = FakeStore()
    service = _service(store)
    service.remember(MemoryDraft(char_id=CHAR, kind="fact", text=" 用户喜欢猫 "), now=0.0)
    service.remember(MemoryDraft(char_id=CHAR, kind="fact", text="用户在上海"), now=123.0)
    assert store.upserted_now == [NOW, 123.0]
    assert store.upserted[0].text == "用户喜欢猫"


# ---------------------------------------------------------------- 组合根


def test_build_memory_service_creates_encrypted_db(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    service = build_memory_service(settings)
    assert service.available is True
    assert service.startup_error is None
    assert service.module_state() == (ModuleState.READY, None)
    assert settings.memory_db_file.is_file()
    assert settings.memory_key_file.is_file()
    assert settings.memory_db_file.read_bytes()[:16] != b"SQLite format 3\x00"


def test_build_memory_service_degrades_when_key_is_broken(tmp_path: Path) -> None:
    """密钥文件坏了不该让 sidecar 起不来：降级成「没有记忆」并让 /health 说明原因。"""
    settings = Settings(data_dir=tmp_path)
    (tmp_path / MEMORY_KEY_NAME).write_bytes(b"XXXX" + bytes([1]) + b"garbage")
    service = build_memory_service(settings)
    assert service.available is False
    assert isinstance(service.startup_error, MemoryKeyInvalidError)
    assert service.module_state() == (ModuleState.ERROR, "key_invalid")
    with pytest.raises(MemoryStoreError) as info:
        service.clear(CHAR)
    assert info.value.code == CODE_MEM_KEY_INVALID
