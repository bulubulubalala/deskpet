"""文件职责：记忆用例层（需求 §6.4 / §5 F3）：记什么、注入什么、失败怎么办。

依赖方向：services -> adapters（库与密钥由 build_memory_service 建好注入）/ core / contracts；
不 import api。
谁调用：api/memory.py 的管理端点；ChatService 经 core.memory.MemoryGateway 协议在每轮对话里读写。
约定：
- 记忆是增强项不是对话链路的必需件：**读失败当作「没有记忆」，写失败只记日志 + 上报环境事件**，
  绝不把 DP-MEM-* 抛进 /chat/stream（§6.4）。管理端点反过来——用户主动点「记住 / 清空」时必须
  看到失败原因，所以那一组方法直接抛 core.errors.MemoryStoreError（DP-MEM-*）。
- 注入预算按固定优先级裁剪：历史 → L0 片段 → L1 → L2，L3 永不裁层（太长只截断）。
- 这里不做摘要、不调模型：阶梯压缩是 T2.1b 的活，本层只负责「按预算取与装」。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import replace

from adapters.memory_key import load_or_create_key
from adapters.memory_sqlite import open_memory_store
from config import MemorySettings, Settings
from contracts.errors import (
    CODE_MEM_INDEX_BROKEN,
    CODE_MEM_KEY_INVALID,
    CODE_MEM_READONLY_FALLBACK,
)
from contracts.health import ModuleState
from core.env_events import EVENT_MEM_KEY_INVALID, EVENT_MEM_READONLY, EnvEventReporter
from core.errors import MemoryStoreError
from core.logging import get_logger, log_event
from core.memory import (
    FactSnippet,
    HistoryRole,
    HistoryTurn,
    MemoryBackendError,
    MemoryDraft,
    MemoryIndexBrokenError,
    MemoryKeyInvalidError,
    MemoryQuery,
    MemoryReadonlyError,
    MemoryRecord,
    MemoryStore,
    MessageDraft,
    MessageRow,
    RecallContext,
    RecallQuery,
    SummarySnippet,
    estimate_tokens,
    truncate_to_tokens,
)

LOGGER = get_logger("services.memory_service")

#: 模块不可用时给 /health 的 detail（机器可读短描述，§6.3）
_DETAIL_BY_ERROR: dict[type[MemoryBackendError], str] = {
    MemoryKeyInvalidError: "key_invalid",
    MemoryReadonlyError: "readonly",
    MemoryIndexBrokenError: "index_broken",
}


class MemoryService:
    """记忆用例层：三个吞失败的对话方法 + 一组会抛错的管理方法。

    store=None 表示「启动时就没能打开记忆库」（密钥失效 / 目录只读）：此时对话链路
    照常跑，只是永远没有记忆可用——这是 §6.4 要求的降级行为，不是错误。
    """

    def __init__(
        self,
        store: MemoryStore | None,
        settings: MemorySettings,
        *,
        env: EnvEventReporter | None = None,
        startup_error: MemoryBackendError | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._env = env
        self._startup_error = startup_error
        # 运行期出现过结构性故障（密钥/只读/索引）也记下来，让 /health 的模块态别再谎报 ready
        self._fault: MemoryBackendError | None = startup_error
        self._now = now or time.time
        if startup_error is not None:
            self._degrade(startup_error, action="startup")

    @property
    def available(self) -> bool:
        """记忆库当前可用吗（不可用时对话链路不记不读）。"""
        return self._store is not None

    @property
    def store(self) -> MemoryStore | None:
        """底层记忆库（None = 打不开）；阶梯压缩（T2.1b）要用它读写摘要与未覆盖原文。"""
        return self._store

    @property
    def startup_error(self) -> MemoryBackendError | None:
        """启动时打开记忆库失败的原始异常（None = 正常）；管理端点据此给错误码。"""
        return self._startup_error

    def module_state(self) -> tuple[ModuleState, str | None]:
        """给 /health 的模块状态：可用=ready，打不开或出过结构性故障=error + 机器可读原因。"""
        fault = self._fault
        if self._store is not None and fault is None:
            return ModuleState.READY, None
        if fault is None:
            return ModuleState.ERROR, "unavailable"
        return ModuleState.ERROR, _DETAIL_BY_ERROR.get(type(fault), "unavailable")

    # ---- 对话链路：全部吞失败（§6.4） ----

    def record_message(
        self, *, char_id: str, session_id: str, role: HistoryRole, text: str, ts: float
    ) -> None:
        """把一轮里的一条消息写进 L0（历史层）。失败只降级，不影响这轮对话。"""
        body = text.strip()
        if self._store is None or not body:
            return
        draft = MessageDraft(
            char_id=char_id,
            session_id=session_id,
            role=role,
            text=body,
            ts=ts,
            token_len=estimate_tokens(body),
        )
        try:
            self._store.add_messages([draft])
        except MemoryBackendError as exc:
            self._degrade(exc, action="record_message")

    def record_facts(
        self,
        *,
        char_id: str,
        session_id: str,
        facts: Sequence[MemoryDraft],
        ts: float,
    ) -> list[int]:
        """写入 LLM 判定「值得长期记住」的事实（m 事件）；返回记忆 id（去重命中算同一条）。"""
        if self._store is None or not facts:
            return []
        ids: list[int] = []
        try:
            for fact in facts:
                body = fact.text.strip()
                if not body:
                    continue
                draft = replace(self._with_defaults(fact, char_id=char_id, ts=ts), text=body)
                memory_id, _created = self._store.upsert_memory(draft, now=ts)
                ids.append(memory_id)
        except MemoryBackendError as exc:
            self._degrade(exc, action="record_facts")
            return []
        return ids

    def recall(self, *, char_id: str, query: str, now: float) -> RecallContext:
        """按预算取一轮要注入的记忆；任何失败都返回「空记忆」并降级上报。"""
        if self._store is None:
            return RecallContext()
        try:
            loaded = self._load_recall(char_id=char_id, query=query, now=now)
        except MemoryBackendError as exc:
            self._degrade(exc, action="recall")
            return RecallContext()
        context = self._fit_recall(loaded)
        if context.injected_ids:
            try:
                self._store.mark_used(list(context.injected_ids), now=now)
            except MemoryBackendError as exc:
                self._degrade(exc, action="mark_used")
        return context

    # ---- 管理端点：失败必须让用户看见（DP-MEM-*） ----

    def remember(self, draft: MemoryDraft, *, now: float = 0.0) -> tuple[int, bool]:
        """手动写入一条记忆；返回 (memory_id, 是否已存在)。

        now=0 表示「用现在」——不传的话 created_at 会落成 0，记忆的排序与衰减就全错了。
        """
        store = self._require_store()
        body = draft.text.strip()
        if not body:
            raise MemoryStoreError(
                CODE_MEM_INDEX_BROKEN,
                "记忆内容为空",
                user_hint="要记住的内容不能是空的。",
            )
        moment = now if now > 0 else self._now()
        try:
            return store.upsert_memory(replace(draft, text=body), now=moment)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def search(self, query: RecallQuery) -> list[FactSnippet]:
        """按查询检索记忆（管理界面 / 调试用）；分数含时间衰减，所以必须带上当前时间。"""
        store = self._require_store()
        effective = query if query.now > 0 else replace(query, now=self._now())
        try:
            return store.search_memories(effective)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        """列出一个角色的记忆（按重要度、时间倒序）。"""
        store = self._require_store()
        try:
            return store.list_memories(query)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def delete(self, memory_id: int) -> bool:
        """删除一条记忆；不存在返回 False 而不是报错（幂等）。"""
        store = self._require_store()
        try:
            return store.delete_memory(memory_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def clear(self, char_id: str, *, keep_days: float | None = None) -> int:
        """清空一个角色的记忆（keep_days 给了就只清更早的）；返回删除条数。"""
        store = self._require_store()
        try:
            return store.clear_memories(char_id, keep_days=keep_days)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    # ---- 内部：取数 → 裁剪 → 组装 ----

    def _load_recall(
        self, *, char_id: str, query: str, now: float
    ) -> tuple[
        SummarySnippet | None,
        list[SummarySnippet],
        list[SummarySnippet],
        list[FactSnippet],
        list[MessageRow],
    ]:
        """一次性把五层数据取出来（读失败由调用方降级）。"""
        store = self._require_store()
        cfg = self._settings
        impressions = store.latest_summary(char_id, 3) if cfg.l3_budget_tokens > 0 else None
        episodes = (
            store.list_summaries(char_id, 2, limit=cfg.episode_limit)
            if cfg.l2_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        summaries = (
            store.list_summaries(char_id, 1, limit=cfg.episode_limit)
            if cfg.l1_budget_tokens > 0 and cfg.episode_limit > 0
            else []
        )
        facts = (
            store.search_memories(
                RecallQuery(char_id=char_id, query=query, now=now, limit=cfg.recall_limit)
            )
            if cfg.recall_limit > 0 and cfg.recall_budget_tokens > 0
            else []
        )
        history = (
            store.recent_messages(char_id, limit=cfg.history_turns * 2)
            if cfg.history_turns > 0 and cfg.history_budget_tokens > 0
            else []
        )
        return impressions, episodes, summaries, facts, history

    def _fit_recall(
        self,
        loaded: tuple[
            SummarySnippet | None,
            list[SummarySnippet],
            list[SummarySnippet],
            list[FactSnippet],
            list[MessageRow],
        ],
    ) -> RecallContext:
        """按「历史 → L0 → L1 → L2，L3 只截不丢」的优先级把数据压进预算（§6.4）。"""
        cfg = self._settings
        impressions_row, episodes, summaries, facts, history = loaded
        dropped: list[str] = []
        impressions = ""
        if impressions_row is not None:
            impressions = truncate_to_tokens(impressions_row.text, cfg.l3_budget_tokens)
            if not impressions:
                dropped.append("l3")
        kept_episodes = _fit_texts([row.text for row in episodes], cfg.l2_budget_tokens)
        if len(kept_episodes) < len(episodes):
            dropped.append("l2")
        kept_summaries = _fit_texts([row.text for row in summaries], cfg.l1_budget_tokens)
        if len(kept_summaries) < len(summaries):
            dropped.append("l1")
        kept_facts = _fit_facts(facts, cfg.recall_budget_tokens)
        if len(kept_facts) < len(facts):
            dropped.append("l0")
        kept_history = _fit_history(history, cfg.history_budget_tokens)
        if len(kept_history) < len(history):
            dropped.append("history")
        return RecallContext(
            impressions=impressions,
            episodes=tuple(kept_episodes),
            summaries=tuple(kept_summaries),
            facts=tuple(kept_facts),
            history=tuple(kept_history),
            injected_ids=tuple(fact.memory_id for fact in kept_facts),
            dropped=tuple(dropped),
        )

    def _with_defaults(self, draft: MemoryDraft, *, char_id: str, ts: float) -> MemoryDraft:
        """补 LLM 没给的字段：角色 id 与发生时间（缺了就按这一轮的时间算）。"""
        patched = draft
        if not patched.char_id:
            patched = replace(patched, char_id=char_id)
        if patched.occurred_at is None:
            patched = replace(patched, occurred_at=ts)
        return patched

    # ---- 内部：降级与错误映射 ----

    def _require_store(self) -> MemoryStore:
        """管理端点用：不可用就把启动时的失败原因抛成 DP-MEM-*。"""
        if self._store is not None:
            return self._store
        raise self._domain_error(self._startup_error or MemoryBackendError("记忆库不可用"))

    def _degrade(self, exc: MemoryBackendError, *, action: str) -> None:
        """对话链路的统一降级：记日志 + 上报环境事件，绝不外抛。"""
        if self._fault is None:
            self._fault = exc
        log_event(
            LOGGER,
            logging.WARNING,
            module="services.memory_service",
            event="memory.degraded",
            message="记忆不可用，本轮按「没有记忆」处理",
            fields={"action": action, "reason": type(exc).__name__, "error": str(exc)},
        )
        self._report_event(exc)

    def _report_event(self, exc: MemoryBackendError) -> None:
        """事实进 fact、用户提示进 user_hint（§6.8）；只有密钥失效与只读降级有事件码。"""
        if self._env is None:
            return
        if isinstance(exc, MemoryKeyInvalidError):
            self._env.report(
                EVENT_MEM_KEY_INVALID,
                fact="记忆库密钥不可用（读不出或与当前库不匹配）",
                user_hint="记忆暂时读不出来，可在设置里重置记忆库后重新开始。",
            )
        elif isinstance(exc, MemoryReadonlyError):
            self._env.report(
                EVENT_MEM_READONLY,
                fact="记忆库不可写（数据目录只读或被占用）",
                user_hint="这轮对话暂时不会被记住。",
            )

    def _domain_error(self, exc: MemoryBackendError) -> MemoryStoreError:
        """把适配器异常翻译成带错误码与用户指引的 DP-MEM-*（§6.5）。"""
        if isinstance(exc, MemoryKeyInvalidError):
            return MemoryStoreError(
                CODE_MEM_KEY_INVALID,
                str(exc),
                user_hint=(
                    "记忆库的密钥读不出来（换过 Windows 用户或换过机器？）。"
                    "重置记忆库可以重新开始。"
                ),
            )
        if isinstance(exc, MemoryReadonlyError):
            return MemoryStoreError(
                CODE_MEM_READONLY_FALLBACK,
                str(exc),
                user_hint="记忆库文件不可写，检查数据目录权限或占用后再试。",
            )
        return MemoryStoreError(
            CODE_MEM_INDEX_BROKEN,
            str(exc),
            user_hint="记忆库的全文索引坏了，可以清空这个角色的记忆后重试。",
        )


def _fit_texts(texts: Sequence[str], budget: int) -> list[str]:
    """按顺序装文本，装到预算用完为止（顺序即优先级）。"""
    if budget <= 0:
        return []
    kept: list[str] = []
    used = 0
    for text in texts:
        cost = estimate_tokens(text)
        if used + cost > budget:
            break
        kept.append(text)
        used += cost
    return kept


def _fit_facts(facts: Sequence[FactSnippet], budget: int) -> list[FactSnippet]:
    """与 _fit_texts 同规则，只是元素换成带 id 的片段（要看 id 做 mark_used）。"""
    if budget <= 0:
        return []
    kept: list[FactSnippet] = []
    used = 0
    for fact in facts:
        cost = estimate_tokens(fact.text)
        if used + cost > budget:
            break
        kept.append(fact)
        used += cost
    return kept


def _fit_history(rows: Sequence[MessageRow], budget: int) -> list[HistoryTurn]:
    """历史从最新往回装（越近越重要），装完再翻回时间正序给模型。"""
    if budget <= 0:
        return []
    kept: list[MessageRow] = []
    used = 0
    for row in reversed(list(rows)):
        cost = estimate_tokens(row.text)
        if used + cost > budget:
            break
        kept.append(row)
        used += cost
    turns = [
        HistoryTurn(
            role="assistant" if row.role == "assistant" else "user",
            text=row.text,
            ts=row.ts,
        )
        for row in reversed(kept)
    ]
    return turns


def build_memory_service(
    settings: Settings,
    *,
    env: EnvEventReporter | None = None,
    store: MemoryStore | None = None,
) -> MemoryService:
    """组合根用的构造器：密钥 → 打开（或建）加密库 → 注入配置与事件总线。

    打开失败（密钥读不出、目录只读、索引损坏）不抛异常：降级成「没有记忆」的服务，
    由 /health 的 memory 模块状态与设置界面把原因告诉用户（§6.4 / §6.7 A 级）。
    """
    startup_error: MemoryBackendError | None = None
    if store is None:
        try:
            key = load_or_create_key(settings.memory_key_file)
            store = open_memory_store(settings.memory_db_file, key=key)
        except MemoryBackendError as exc:
            startup_error = exc
            log_event(
                LOGGER,
                logging.ERROR,
                module="services.memory_service",
                event="memory.unavailable",
                message="记忆库打不开，本次运行不记也不读记忆",
                fields={"reason": type(exc).__name__, "error": str(exc)},
            )
    return MemoryService(
        store,
        settings.memory,
        env=env,
        startup_error=startup_error,
    )
