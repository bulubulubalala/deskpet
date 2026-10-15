"""文件职责：会话主流程——角色包 + 模型流 → §6.2 事件流（/chat/stream 的业务层）。

依赖方向：services -> adapters（客户端由组合根注入）/ core / contracts；不 import api。
谁调用：sidecar/app.py 组合根构造，api/chat.py 把它包成 SSE 响应。

边界与责任（§6.2 / §6.7 / §7.4）：
- 事件流只有「角色演出」与「技术提示」两类出口，且角色台词绝不携带技术细节；
- 模型输出的每一行都当作**不可信数据**解析：解析失败就降级成纯文本台词，绝不执行、
  也绝不因为一行坏数据丢掉整轮回复；
- 重试只在「本轮还没产出任何事件」时发生（§6.7：已生成的内容照常播完，禁止重播上一句）；
- 首 token 20s、整体 60s 是硬超时；取消（客户端断连）靠生成器关闭传播到 httpx 流。
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pathlib import Path

from pydantic import ValidationError

from adapters.llm_openai import (
    USER_HINT_BAD_RESPONSE,
    USER_HINT_NETWORK,
    USER_HINT_TIMEOUT,
    LlmEndpoint,
    OpenAiChatClient,
)
from config import LlmSettings, Settings
from contracts.api_models import ChatStreamRequest
from contracts.errors import CODE_LLM_BAD_RESPONSE, CODE_LLM_TIMEOUT, CODE_PACK_FIELD_MISSING
from contracts.events import (
    LLM_EVENT_ADAPTER,
    EndEvent,
    ErrorEvent,
    LlmEvent,
    MemoryEvent,
    SentenceEvent,
)
from core.env_events import EVENT_NET_DOWN, EnvEventReporter
from core.errors import LlmError, PackError
from core.logging import get_logger, log_event
from core.memory import CompressionScheduler, MemoryDraft, MemoryGateway, RecallContext
from core.prompt import build_messages, build_variation
from core.text import split_sentences
from core.usage import UsageRecorder
from services.character_store import LoadedPack, load_character_pack

LOGGER = get_logger("sidecar.services.chat")

#: 没配端点时的提示（§6.3 的配置来自 .env，见仓库根 .env.example）
USER_HINT_NOT_CONFIGURED = (
    "还没有配置模型服务：请在 .env 里填 DESKPET_LLM_BASE_URL、"
    "DESKPET_LLM_API_KEY、DESKPET_LLM_MODEL"
)
USER_HINT_PACK_MISSING = "找不到这个角色包，或者角色包格式有问题"

ClientFactory = Callable[[LlmEndpoint], OpenAiChatClient]
Sleep = Callable[[float], Awaitable[None]]


#: 整行 json.loads 失败时用的兜底：模型偶尔在闭合花括号前多写一个引号，
#: 但 text 字段本身是完整的。只取字符串值，绝不做解释或求值。
_TEXT_FIELD_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _loose_text(raw: str) -> str | None:
    """用正则从坏 JSON 里捞出 text 字段的字面量（捞不到返回 None）。"""
    match = _TEXT_FIELD_RE.search(raw)
    if match is None:
        return None
    try:
        value = json.loads('"' + match.group(1) + '"')
    except ValueError:
        return None
    stripped = value.strip()
    return stripped or None


def _is_open_json(text: str) -> bool:
    """text 是否看起来是「一条还没闭合的 JSON 事件」（用于跨行拼回，§6.2）。"""
    stripped = text.strip()
    if not stripped.startswith("{"):
        return False
    depth = 0
    in_string = False
    escaped = False
    for char in stripped:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return False
    return True


def _salvaged_text(raw: str) -> str | None:
    """从「整行是 JSON 但字段不合规」的报文里捞出还能当台词念的 text 字段。

    典型场景：模型给出的台词超过 40 字上限，事件校验失败。此时若把整行 JSON 原文
    当纯文本播报，用户会听到一串花括号；能捞出 text 就用它（§6.2 的降级是「说人话」）。
    整行连 JSON 都不是时走 _loose_text（真机见过「多一个引号」导致整行解析失败）。
    """
    try:
        payload = json.loads(raw)
    except ValueError:
        return _loose_text(raw)
    if not isinstance(payload, dict):
        return _loose_text(raw)
    value = payload.get("text")
    if isinstance(value, str) and value.strip():
        return value
    return _loose_text(raw)


class ChatService:
    """把「一条用户输入」变成「一串事件」；所有外部依赖都从构造函数注入（可单测）。"""

    def __init__(
        self,
        *,
        llm: LlmSettings,
        characters_dir: Path,
        client_factory: ClientFactory | None = None,
        sleep: Sleep | None = None,
        usage: UsageRecorder | None = None,
        env: EnvEventReporter | None = None,
        memory: MemoryGateway | None = None,
        summarizer: CompressionScheduler | None = None,
        now: Callable[[], float] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._llm = llm
        self._characters_dir = characters_dir
        self._client_factory = client_factory or self._build_client
        self._sleep = sleep or asyncio.sleep
        # 使用统计（§6.9）：记事实而不落盘，写盘时机由 UsageService 决定；None = 不记录
        self._usage = usage
        # 环境事件（§6.8）：断网登记 net.down，恢复即撤销；None = 不上报
        self._env = env
        # 记忆（§6.4）：读写都吞失败；None = 这个进程没有记忆
        self._memory = memory
        # 阶梯压缩（T2.1b）：每轮收尾后 fire-and-forget，不阻塞这一轮
        self._summarizer = summarizer
        # 此刻状态（F8 验收 2）：时间与情绪可注入，单测才能复现同一段提示词
        self._now = now or time.time
        self._rng = rng or random.Random()

    # ------------------------------------------------------------------ 端点

    def _build_client(self, endpoint: LlmEndpoint) -> OpenAiChatClient:
        """生产路径：真实 HTTP 客户端，超时用总时长上限兜底（首 token 由本模块管）。"""
        return OpenAiChatClient(endpoint, timeout_s=self._llm.total_timeout_s)

    def endpoints(self) -> tuple[tuple[LlmEndpoint, str], ...]:
        """按 provider 给出「端点 + 供给标签」的有序表（§6.7 第二层降级 / §6.13）。

        顺序由 LlmSettings.endpoint_specs() 决定：选中的 provider → 显式 fallback → 另一个
        已配好的 provider。标签（cloud / local / fallback）会写进使用统计，所以「这一轮到底
        走的是哪个供给」事后查得到（§6.9）；一个端点都没配就返回空表。
        """
        return tuple(
            (LlmEndpoint(base_url=url, api_key=api_key, model=model), label)
            for url, api_key, model, label in self._llm.endpoint_specs()
        )

    # ------------------------------------------------------------ 主流程

    async def stream_events(self, request: ChatStreamRequest) -> AsyncIterator[LlmEvent]:
        """本轮会话的事件流；任何失败都收敛成 ErrorEvent + EndEvent（HTTP 层已发 200）。"""
        endpoints = self.endpoints()
        if not endpoints:
            yield ErrorEvent(
                code=CODE_LLM_BAD_RESPONSE, user_hint=USER_HINT_NOT_CONFIGURED, recoverable=False
            )
            yield EndEvent()
            return

        try:
            pack = self._load_pack(request.char_id)
        except PackError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="sidecar.services.chat",
                event="chat.pack_missing",
                message="角色包加载失败，本轮无法开始",
                code=exc.code,
                domain=exc.domain,
                fields={"char_id": request.char_id},
            )
            yield ErrorEvent(
                code=exc.code, user_hint=exc.user_hint or USER_HINT_PACK_MISSING, recoverable=False
            )
            yield EndEvent()
            return

        # 先取记忆再组装提示词：本轮这句还没入库，所以检索不到自己（§6.4）
        recall = self._recall_memory(request)
        # 每轮都换一段「此刻状态」：模型至少拿到一个随机化变量，开场才不会千篇一律（F8 验收 2）
        variation = build_variation(pack.card, now=self._now(), rng=self._rng)
        messages = build_messages(
            pack.card,
            user_text=request.text,
            screen_text=request.screen_text,
            language=pack.card.language,
            emotion_labels=tuple(pack.emotions.keys()),
            variation=variation,
            recall=recall,
        )
        log_event(
            LOGGER,
            logging.INFO,
            module="sidecar.services.chat",
            event="chat.start",
            message="开始生成回复",
            fields={
                "session_id": request.session_id,
                "char_id": request.char_id,
                "input_mode": request.input_mode,
                "endpoints": len(endpoints),
                "recall_tokens": recall.tokens,
                "recall_dropped": ",".join(recall.dropped),
            },
        )
        self._record_turn(request)
        spoken: list[str] = []
        facts: list[MemoryDraft] = []
        try:
            async for event in self._stream_with_fallback(endpoints, messages, request):
                self._collect_for_memory(event, spoken, facts)
                yield event
        finally:
            # 无论正常收尾、模型报错还是被用户打断，已经发生的事都记下来（§6.4）
            self._save_memory(request, spoken, facts)
            # 攒够了就在后台压一批（T2.1b）；只排任务，不等它做完
            self._maybe_compress(request.char_id)
        if self._usage is not None:
            # 批量写盘机会：攒够一个窗口（默认 5 分钟）才真的写，避免逐条消息写盘
            await self._usage.flush_if_due()

    def record_interrupt(self, session_id: str) -> None:
        """记一次打断（api 层在客户端断连或本机打断时调用，§6.9 的 interrupt_count）。"""
        if self._usage is not None:
            self._usage.record_interrupt(session_id)

    def _record_provider(self, session_id: str, name: str) -> None:
        """记下本轮**实际用上**的模型供给（§6.13：usage.db 的 llm_provider 列）。

        在主用失败、切到备用或另一个 provider 之后回填，所以事后能看出「这一轮切过供给」。
        """
        if self._usage is not None:
            self._usage.record_provider(session_id, name)

    def _record_turn(self, request: ChatStreamRequest) -> None:
        """把「这一轮用户输入」记进使用统计（voice / text 分流，§6.9）。"""
        if self._usage is None:
            return
        self._usage.record_turn(
            request.session_id,
            request.char_id,
            voice=request.input_mode == "voice",
        )

    # ------------------------------------------------------------ 记忆（§6.4）

    def _recall_memory(self, request: ChatStreamRequest) -> RecallContext:
        """取本轮要注入的记忆；没有记忆通道就返回空上下文（提示词与历史行为完全一致）。"""
        if self._memory is None:
            return RecallContext()
        return self._memory.recall(
            char_id=request.char_id,
            query=request.text,
            now=self._now(),
        )

    def _collect_for_memory(
        self, event: LlmEvent, spoken: list[str], facts: list[MemoryDraft]
    ) -> None:
        """顺手收集这轮**真的产出了**的内容：播出去的台词与 m 事件。

        char_id 留空——它由 MemoryService 在落库时补上（core/memory.MemoryDraft 的约定），
        这样解析事件的地方不必知道正在跟哪个角色说话。
        """
        if isinstance(event, SentenceEvent):
            spoken.append(event.text)
        elif isinstance(event, MemoryEvent):
            facts.append(
                MemoryDraft(
                    char_id="",
                    kind=event.kind,
                    text=event.text,
                    importance=event.importance,
                    source="chat",
                )
            )

    def _save_memory(
        self, request: ChatStreamRequest, spoken: Sequence[str], facts: Sequence[MemoryDraft]
    ) -> None:
        """一轮结束后写 L0（§6.4）：用户这句 + 播出去的台词 + 模型标出的长期事实。

        屏幕文本不入库：OCR 是**不可信输入**，记住了只会污染以后的每一轮（§7.4）。
        写失败只记日志——记忆是增强项，绝不能因为它把这轮请求搞崩。
        """
        if self._memory is None:
            return
        moment = self._now()
        try:
            self._memory.record_message(
                char_id=request.char_id,
                session_id=request.session_id,
                role="user",
                text=request.text,
                ts=moment,
            )
            for text in spoken:
                self._memory.record_message(
                    char_id=request.char_id,
                    session_id=request.session_id,
                    role="assistant",
                    text=text,
                    ts=moment,
                )
            if facts:
                self._memory.record_facts(
                    char_id=request.char_id,
                    session_id=request.session_id,
                    facts=list(facts),
                    ts=moment,
                )
        except Exception as exc:  # 记忆写失败绝不能打断对话（§6.7 A 级）
            log_event(
                LOGGER,
                logging.ERROR,
                module="sidecar.services.chat",
                event="chat.memory_write_failed",
                message="记忆写入失败，这一轮不会影响对话本身",
                fields={"reason": type(exc).__name__, "error": str(exc)},
            )

    def _maybe_compress(self, char_id: str) -> None:
        """对话收尾后安排一次阶梯压缩；任何毛病都只记日志，绝不影响本轮。"""
        if self._summarizer is None:
            return
        try:
            self._summarizer.schedule(char_id)
        except Exception as exc:  # 兜底：压缩是增强项（§6.4）
            log_event(
                LOGGER,
                logging.WARNING,
                module="sidecar.services.chat",
                event="chat.compress_failed",
                message="安排记忆压缩失败，本轮忽略",
                fields={"char_id": char_id, "reason": type(exc).__name__},
            )

    async def _stream_with_fallback(
        self,
        endpoints: Sequence[tuple[LlmEndpoint, str]],
        messages: Sequence[dict[str, str]],
        request: ChatStreamRequest,
    ) -> AsyncIterator[LlmEvent]:
        """逐个端点、逐次退避地尝试；失败要么重试（尚未产出事件），要么如实收尾。"""
        delays = self._llm.retry_delays_s
        last_error: LlmError | None = None
        for endpoint, provider_label in endpoints:
            for attempt in range(len(delays) + 1):
                if attempt > 0:
                    delay = delays[attempt - 1]
                    log_event(
                        LOGGER,
                        logging.INFO,
                        module="sidecar.services.chat",
                        event="chat.retry",
                        message="模型请求失败，退避后重试",
                        code=last_error.code if last_error else None,
                        fields={"attempt": attempt, "delay_s": delay},
                    )
                    await self._sleep(delay)
                emitted = False
                try:
                    async for event in self._stream_once(endpoint, messages, request):
                        emitted = True
                        yield event
                    self._clear_net_error()
                    self._record_provider(request.session_id, provider_label)
                    return
                except LlmError as exc:
                    last_error = exc
                    self._report_net_error(exc)
                except TimeoutError:
                    last_error = LlmError(
                        CODE_LLM_TIMEOUT, "模型首 token / 总时长超时", user_hint=USER_HINT_TIMEOUT
                    )
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="sidecar.services.chat",
                    event="chat.attempt_failed",
                    message="这一次模型请求失败",
                    code=last_error.code,
                    domain=last_error.domain,
                    trace=str(last_error),
                    fields={"emitted": emitted, "base_url": endpoint.base_url},
                )
                if emitted:
                    # 已经播出去的内容不能收回，也绝不重播上一句（§6.7）
                    log_event(
                        LOGGER,
                        logging.WARNING,
                        module="sidecar.services.chat",
                        event="chat.interrupted",
                        message="流中断在产出之后，直接收尾",
                        code=last_error.code,
                    )
                    yield ErrorEvent(
                        code=last_error.code,
                        user_hint=last_error.user_hint or USER_HINT_NETWORK,
                        recoverable=True,
                    )
                    yield EndEvent()
                    return

        final = last_error or LlmError(
            CODE_LLM_BAD_RESPONSE, "模型没有返回任何内容", user_hint=USER_HINT_BAD_RESPONSE
        )
        log_event(
            LOGGER,
            logging.ERROR,
            module="sidecar.services.chat",
            event="chat.failed",
            message="所有端点与重试都用尽",
            code=final.code,
            domain=final.domain,
        )
        yield ErrorEvent(
            code=final.code, user_hint=final.user_hint or USER_HINT_NETWORK, recoverable=True
        )
        yield EndEvent()

    # ------------------------------------------------------- 环境事件（§6.8）

    def _report_net_error(self, error: LlmError) -> None:
        """把「连不上模型服务」登记成 net.down；端点没配 / 鉴权错不算断网。"""
        if self._env is None or not _is_network_error(error):
            return
        self._env.report(
            EVENT_NET_DOWN,
            fact="连不上模型服务（网络不通）",
            user_hint=error.user_hint or USER_HINT_NETWORK,
        )

    def _clear_net_error(self) -> None:
        """这一轮有内容产出即认为网络恢复，撤销 net.down（§6.8）。"""
        if self._env is not None:
            self._env.clear(event_id=EVENT_NET_DOWN)

    async def _stream_once(
        self,
        endpoint: LlmEndpoint,
        messages: Sequence[dict[str, str]],
        request: ChatStreamRequest,
    ) -> AsyncIterator[LlmEvent]:
        """单个端点的一次尝试：把文本增量解析成事件，并以 EndEvent 收尾。"""
        client = self._client_factory(endpoint)
        buffer = ""
        pending = ""
        index = 0
        produced = False
        fallback_logged = False
        async for delta in self._iterate_deltas(client, messages):
            buffer += delta
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if pending:
                    line = pending + "\n" + line
                    pending = ""
                if _is_open_json(line):
                    # 模型偶尔把一条事件写成多行（缩进过的 JSON）：攒到闭合再解析，
                    # 否则每一行都会被当成台词念出来（真机上见过花括号被念给用户）。
                    pending = line
                    continue
                events, index, fallback_logged = self._events_from_line(
                    line, index, fallback_logged
                )
                for event in events:
                    produced = True
                    if isinstance(event, EndEvent):
                        log_event(
                            LOGGER,
                            logging.INFO,
                            module="sidecar.services.chat",
                            event="chat.end",
                            message="本轮回复结束",
                            fields={"session_id": request.session_id, "sentences": index},
                        )
                        yield event
                        return
                    yield event
        leftover = pending + "\n" + buffer if pending else buffer
        events, index, fallback_logged = self._events_from_line(leftover, index, fallback_logged)
        for event in events:
            produced = True
            if isinstance(event, EndEvent):
                yield event
                return
            yield event
        if not produced:
            # 流正常结束但一个事件都没有：多半是端点不认 stream=true（回了非 SSE 报文）
            raise LlmError(
                CODE_LLM_BAD_RESPONSE,
                "模型流结束了但没有任何内容",
                user_hint=USER_HINT_BAD_RESPONSE,
                context={"base_url": endpoint.base_url},
            )
        log_event(
            LOGGER,
            logging.INFO,
            module="sidecar.services.chat",
            event="chat.end",
            message="模型流结束但没收到 end 事件，由服务层补一个",
            fields={"session_id": request.session_id, "sentences": index},
        )
        yield EndEvent()

    # ------------------------------------------------------------ 解析与超时

    def _events_from_line(
        self, line: str, index: int, fallback_logged: bool
    ) -> tuple[list[LlmEvent], int, bool]:
        """解析一行模型输出 → 事件列表 + 新的句子序号 + 是否已记过降级警告。

        合法 JSON 事件直接用（跨行的事件由 _stream_once 先拼回）；解析失败分两种降级：
        能捞出 text 字段就念它（§6.2「说人话」），捞不到就整行丢掉——真机上见过模型多写
        一个引号导致校验失败，而按纯文本播报会把花括号片段念给用户。警告只记一次。
        """
        stripped = line.strip()
        if not stripped:
            return [], index, fallback_logged

        reason: str | None = None
        text = stripped
        if stripped.startswith("{"):
            try:
                event = LLM_EVENT_ADAPTER.validate_json(stripped)
            except ValidationError as exc:
                first: dict[str, object] = dict(exc.errors()[0]) if exc.errors() else {}
                reason = str(first.get("type", "invalid"))
                salvaged = _salvaged_text(stripped)
                if salvaged is None:
                    self._log_fallback(len(stripped), reason, fallback_logged)
                    return [], index, True
                text = salvaged
            else:
                if isinstance(event, SentenceEvent):
                    return [event], max(index, event.i + 1), fallback_logged
                return [event], index, fallback_logged
        else:
            reason = "not_json"

        self._log_fallback(len(stripped), reason, fallback_logged)
        events: list[LlmEvent] = [
            SentenceEvent(text=piece, i=index + offset)
            for offset, piece in enumerate(split_sentences(text))
        ]
        return events, index + len(events), True

    def _log_fallback(self, chars: int, reason: str | None, already_logged: bool) -> None:
        """降级警告每轮只记一次，否则一行坏数据就能把日志刷满。"""
        if already_logged:
            return
        log_event(
            LOGGER,
            logging.WARNING,
            module="sidecar.services.chat",
            event="chat.plain_text_fallback",
            message="模型输出不是合法事件行，已降级处理",
            fields={"chars": chars, "reason": reason},
        )

    async def _iterate_deltas(
        self,
        client: OpenAiChatClient,
        messages: Sequence[dict[str, str]],
    ) -> AsyncIterator[str]:
        """带两段超时地消费模型流：首 token 用 first_token_timeout_s，其后受总时长约束。

        超时统一转成 LlmError（DP-LLM-003），让上层按 §6.7 决定重试还是收尾。
        """
        stream = client.stream_chat(messages)
        iterator = stream.__aiter__()
        deadline = time.monotonic() + self._llm.total_timeout_s
        first = True
        try:
            while True:
                if first:
                    budget = self._llm.first_token_timeout_s
                else:
                    budget = max(deadline - time.monotonic(), 0.001)
                try:
                    delta = await asyncio.wait_for(iterator.__anext__(), budget)
                except StopAsyncIteration:
                    return
                except TimeoutError as exc:
                    raise LlmError(
                        CODE_LLM_TIMEOUT,
                        "模型首 token 超时" if first else "模型响应超过总时长上限",
                        user_hint=USER_HINT_TIMEOUT,
                        context={"first_token": first},
                    ) from exc
                first = False
                yield delta
        finally:
            # stream_chat 声明的返回类型是 AsyncIterator，实际的异步生成器多一个 aclose；
            # 用 getattr 兜底，既关得掉流，也不给类型检查制造假接口。
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()

    # ------------------------------------------------------------ 角色包

    def _load_pack(self, char_id: str) -> LoadedPack:
        """读角色包；找不到或字段非法一律抛 PackError（由调用方转成 ErrorEvent）。"""
        root = self._characters_dir / char_id
        loaded = load_character_pack(root)
        if not loaded.ok:
            reasons = "；".join(issue.message for issue in loaded.issues if issue.level == "error")
            raise PackError(
                CODE_PACK_FIELD_MISSING,
                "角色包 " + char_id + " 不可用：" + (reasons or "未通过体检"),
                user_hint=USER_HINT_PACK_MISSING,
                context={"char_id": char_id},
            )
        return loaded


def _is_network_error(error: LlmError) -> bool:
    """适配器把 httpx 连接层错误标成 DP-LLM-003 + 网络提示（adapters/llm_openai.py）。

    只认这一种组合：超时（首 token / 总时长）同样是 DP-LLM-003，但它不是「断网」，
    不该让角色说「我联系不上外面的脑子」。
    """
    return error.code == CODE_LLM_TIMEOUT and error.user_hint == USER_HINT_NETWORK


def build_chat_service(
    settings: Settings,
    *,
    usage: UsageRecorder | None = None,
    env: EnvEventReporter | None = None,
    memory: MemoryGateway | None = None,
    summarizer: CompressionScheduler | None = None,
) -> ChatService:
    """组合根用的便捷构造：从 Settings 取 LLM 配置与角色包目录，并接上统计、事件与记忆。"""
    return ChatService(
        llm=settings.llm,
        characters_dir=settings.characters_dir,
        usage=usage,
        env=env,
        memory=memory,
        summarizer=summarizer,
    )


__all__ = ["USER_HINT_NOT_CONFIGURED", "ChatService", "build_chat_service"]
