"""文件职责：阶梯压缩的**生成**侧（需求 §6.4 / F3 验收 2）：L0 原文 → L1 → L2 → L3。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：ChatService 每轮对话收尾后 fire-and-forget（schedule），组合根用
build_memory_summarizer 构造；测试直接 await compress() 即可。

约定：
- 只做增量：每次最多压一批；没到阈值什么都不做（阈值见 MemorySettings）。
- 全程吞失败：模型没配、限流、超时、库写失败都只记日志——记忆是增强项（§6.4），
  后台压缩绝不能把异常抛回对话链路。
- 摘要是「自产内容」= 可信（§7.4）；原文一律裹进 <untrusted_input> 再交给模型，
  并要求它只做归纳、不许执行里面的任何指令（用户原话也可能带注入）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterable, Sequence

from adapters.llm_openai import LlmEndpoint, OpenAiChatClient
from config import LlmSettings, MemorySettings, Settings
from core.logging import get_logger, log_event
from core.memory import (
    MemoryBackendError,
    MemoryStore,
    MessageRow,
    SummarySnippet,
    truncate_to_tokens,
)
from core.prompt import wrap_untrusted

LOGGER = get_logger("services.memory_summary_service")

ClientFactory = Callable[[LlmEndpoint], OpenAiChatClient]

#: 一次生成最多收这么多字符，防模型跑飞把内存和库撑爆。
MAX_OUTPUT_CHARS = 4000
#: 聚合时一次最多回看多少条下层摘要。
_SOURCE_SCAN_LIMIT = 200
#: 摘要再短也要留这么多 token，否则压缩等于丢记忆。
_MIN_SUMMARY_TOKENS = 60

_SYSTEM_L1 = (
    "你是对话记忆压缩器。把用户给你的这段对话原文压缩成中文摘要。"
    "只保留这些内容：用户的事实与偏好、双方约定与承诺、还没解决的话题、以后值得再提起的细节。"
    "不要评价，不要加戏，不要编造原文里没有的信息。直接输出摘要正文，不要标题，不要解释。"
)
_SYSTEM_L2 = (
    "你是对话记忆压缩器。把用户给你的几条阶段摘要合并成一条中文梗概。"
    "保留关系进展、用户反复提到的偏好与禁忌、仍然悬着的事。"
    "合并重复内容，不要新增原文没有的信息。直接输出梗概正文，不要标题，不要解释。"
)
_SYSTEM_L3 = (
    "你是对话记忆压缩器。根据用户给你的几条章节梗概，写一段中文长期印象："
    "用户是个什么样的人、你和用户的关系走到哪一步、用户在意什么与忌讳什么、还有哪些事没解决。"
    "只写有依据的内容，宁可短也不要编。直接输出印象正文，不要标题，不要解释。"
)


class MemorySummarizer:
    """按阈值把下层内容逐级压成摘要；所有失败都只记日志（F3 是增强项）。"""

    def __init__(
        self,
        store: MemoryStore | None,
        settings: MemorySettings,
        *,
        llm: LlmSettings,
        client_factory: ClientFactory | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._llm = llm
        self._client_factory = client_factory or self._build_client
        self._now = now or time.time
        # 同一个角色同时只跑一个压缩任务；_tasks 持有引用，避免任务被 GC 提前回收
        self._running: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def available(self) -> bool:
        """记忆库可用吗（不可用时 schedule 空转）。"""
        return self._store is not None

    def _build_client(self, endpoint: LlmEndpoint) -> OpenAiChatClient:
        """生产路径：真实 HTTP 客户端，超时沿用 LLM 总时长上限（§6.7）。"""
        return OpenAiChatClient(endpoint, timeout_s=self._llm.total_timeout_s)

    # ---------------------------------------------------------- 调度（对话收尾）

    def schedule(self, char_id: str) -> None:
        """安排一次后台压缩；没有事件循环或已经在压就跳过（绝不阻塞这一轮）。"""
        if self._store is None or not char_id or char_id in self._running:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._running.add(char_id)
        task = loop.create_task(self._guarded(char_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _guarded(self, char_id: str) -> None:
        """包一层，保证 _running 一定被清掉（compress 自己兜住了所有异常）。"""
        try:
            await self.compress(char_id)
        finally:
            self._running.discard(char_id)

    async def compress(self, char_id: str) -> int:
        """压一批：先 L1，再顺着阶梯向上聚合；返回本次新建的摘要条数。"""
        if self._store is None:
            return 0
        created = 0
        try:
            created += await self._compress_l1(char_id)
            created += await self._aggregate_l2(char_id)
            created += await self._aggregate_l3(char_id)
        except MemoryBackendError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_summary_service",
                event="memory.summary_failed",
                message="阶梯压缩写库失败，这一批不做",
                fields={"char_id": char_id, "reason": type(exc).__name__, "error": str(exc)},
            )
            return created
        except Exception as exc:  # 兜底：后台任务绝不能把异常抛回对话链路
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_summary_service",
                event="memory.summary_failed",
                message="阶梯压缩意外失败，这一批不做",
                fields={"char_id": char_id, "reason": type(exc).__name__, "error": str(exc)},
            )
            return created
        if created:
            log_event(
                LOGGER,
                logging.INFO,
                module="services.memory_summary_service",
                event="memory.summarized",
                message="阶梯压缩完成",
                fields={"char_id": char_id, "created": created},
            )
        return created

    # ------------------------------------------------------------------ L1 / L2 / L3

    async def _compress_l1(self, char_id: str) -> int:
        """把够量的未覆盖原文压成一条 L1 摘要，并把这些消息标记为已覆盖。"""
        store = self._store
        if store is None:
            return 0
        cfg = self._settings
        limit = max(cfg.summary_batch_messages, cfg.summary_trigger_messages)
        rows = store.uncovered_messages(char_id, limit=limit)
        if not _triggered(rows, cfg):
            return 0
        text = await self._complete(
            _SYSTEM_L1, _render_messages(rows), target_tokens=cfg.l1_budget_tokens
        )
        if not text:
            return 0
        summary_id = store.add_summary(
            char_id=char_id,
            tier=1,
            text=text,
            covers_from=rows[0].ts,
            covers_to=rows[-1].ts,
            source_ids=_csv(row.message_id for row in rows),
            now=self._now(),
        )
        store.mark_covered([row.message_id for row in rows], summary_id=summary_id)
        return 1

    async def _aggregate_l2(self, char_id: str) -> int:
        """多条 L1 聚成一条 L2 章节梗概。"""
        return await self._aggregate(
            char_id,
            source_tier=1,
            target_tier=2,
            minimum=self._settings.l1_aggregate_summaries,
            system=_SYSTEM_L2,
            target_tokens=self._settings.l2_budget_tokens,
        )

    async def _aggregate_l3(self, char_id: str) -> int:
        """多条 L2 归纳成一条 L3 长期印象（recall 读的是最新那条）。"""
        return await self._aggregate(
            char_id,
            source_tier=2,
            target_tier=3,
            minimum=self._settings.l2_aggregate_summaries,
            system=_SYSTEM_L3,
            target_tokens=self._settings.l3_budget_tokens,
        )

    async def _aggregate(
        self,
        char_id: str,
        *,
        source_tier: int,
        target_tier: int,
        minimum: int,
        system: str,
        target_tokens: int,
    ) -> int:
        """通用聚合：取上一层「还没被聚合过」的摘要，够 minimum 条就压成一条。"""
        store = self._store
        if store is None or minimum <= 0:
            return 0
        previous = store.latest_summary(char_id, target_tier)
        after = _max_source_id(previous.source_ids) if previous is not None else 0
        candidates = [
            row
            for row in store.list_summaries(char_id, source_tier, limit=_SOURCE_SCAN_LIMIT)
            if row.summary_id > after
        ]
        if len(candidates) < minimum:
            return 0
        candidates.sort(key=lambda row: row.summary_id)
        text = await self._complete(
            system, _render_summaries(candidates), target_tokens=target_tokens
        )
        if not text:
            return 0
        now = self._now()
        store.add_summary(
            char_id=char_id,
            tier=target_tier,
            text=text,
            # 聚合层的 covers_from 没有独立来源（SummarySnippet 只带 covers_to），用 0 表示未跟踪
            covers_from=0.0,
            covers_to=max(row.covers_to for row in candidates),
            source_ids=_csv(row.summary_id for row in candidates),
            now=now,
        )
        store.mark_summaries_archived(
            [row.summary_id for row in candidates],
            now=now,
        )
        return 1

    # ------------------------------------------------------------------ 模型调用

    async def _complete(self, system: str, user: str, *, target_tokens: int) -> str:
        """走第一个可用端点把摘要整段取回来；没配模型或调用失败返回空串。"""
        specs = self._llm.endpoint_specs()
        if not specs:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_summary_service",
                event="memory.summary_no_model",
                message="没有配置模型端点，跳过阶梯压缩",
            )
            return ""
        url, api_key, model, label = specs[0]
        client = self._client_factory(LlmEndpoint(base_url=url, api_key=api_key, model=model))
        chunks: list[str] = []
        total = 0
        try:
            async for delta in client.stream_chat(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ]
            ):
                chunks.append(delta)
                total += len(delta)
                if total >= MAX_OUTPUT_CHARS:
                    break
        except Exception as exc:  # 模型侧任何毛病都不许冒泡（含 LlmError）
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_summary_service",
                event="memory.summary_failed",
                message="摘要生成失败，这一批不压缩",
                fields={"provider": label, "reason": type(exc).__name__, "error": str(exc)},
            )
            return ""
        text = "".join(chunks).strip()
        if not text:
            return ""
        return truncate_to_tokens(text, max(_MIN_SUMMARY_TOKENS, target_tokens * 2))


def _triggered(rows: Sequence[MessageRow], cfg: MemorySettings) -> bool:
    """条数或估算 token 任一越线就压；两个阈值都为 0 视为关闭阶梯压缩。"""
    if not rows:
        return False
    if cfg.summary_trigger_messages > 0 and len(rows) >= cfg.summary_trigger_messages:
        return True
    if cfg.summary_trigger_tokens > 0:
        return sum(row.token_len for row in rows) >= cfg.summary_trigger_tokens
    return False


def _render_messages(rows: Sequence[MessageRow]) -> str:
    """把原文拼成「用户/我：…」的行，并整体裹成不可信输入。"""
    lines = [("我：" if row.role == "assistant" else "用户：") + row.text for row in rows]
    body = "\n".join(lines)
    return "把下面这段对话原文压缩成摘要：\n" + wrap_untrusted(body, what="一段过往对话的原文")


def _render_summaries(rows: Sequence[SummarySnippet]) -> str:
    """把下层摘要拼成条目列表，同样裹成不可信输入（防摘要里混进注入）。"""
    body = "\n".join("- " + row.text for row in rows)
    return "把下面这些摘要合并：\n" + wrap_untrusted(body, what="之前几轮生成的摘要")


def _csv(values: Iterable[int]) -> str:
    """把 id 列表写成 source_ids 字段用的逗号串。"""
    return ",".join(str(value) for value in values)


def _max_source_id(raw: str) -> int:
    """从 source_ids 里取最大 id（用来判断「上层已经聚合到哪一条」）。"""
    best = 0
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            best = max(best, int(part))
    return best


def build_memory_summarizer(
    settings: Settings,
    store: MemoryStore | None,
    *,
    client_factory: ClientFactory | None = None,
) -> MemorySummarizer:
    """组合根用：库不可用（None）时 available=False，schedule 直接空转（§6.4 降级）。"""
    return MemorySummarizer(
        store,
        settings.memory,
        llm=settings.llm,
        client_factory=client_factory,
    )
