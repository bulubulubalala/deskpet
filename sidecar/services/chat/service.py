"""文件职责：会话主流程——角色包 + 模型流 → §6.2 事件流（/chat/stream 的业务层）。

本模块只回答三件事：这一轮该拿什么提示词、哪些事实要记、失败怎么收敛成事件。
其余细节按职责分在同目录：
- chat/line_parser.py   模型输出的每一行是**不可信数据**，怎么降级成台词；
- chat/stream_runner.py 多端点降级 / 退避重试 / 两段超时 / 断流收尾（§6.7）；
- chat/memory_bridge.py 记忆读写、角色状态、收尾后的后台整理（§6.4）。

依赖方向：services -> adapters（客户端由组合根注入）/ core / contracts；不 import api。
谁调用：sidecar/app.py 组合根构造，api/chat.py 把它包成 SSE 响应。
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from adapters.llm_openai import LlmEndpoint, OpenAiChatClient
from config import LlmSettings, Settings
from contracts.api_models import ChatStreamRequest
from contracts.errors import CODE_LLM_BAD_RESPONSE, CODE_PACK_FIELD_MISSING
from contracts.events import EndEvent, ErrorEvent, LlmEvent
from core.emotion import mood_valence
from core.env_events import EnvEventReporter, render_character_facts
from core.error_detail import build_error_detail, manual_error_detail
from core.errors import PackError
from core.logging import get_logger, log_event
from core.memory import BehaviorScheduler, CompressionScheduler, MemoryDraft, MemoryGateway
from core.prompt import InteractionEvent, build_messages, build_user_text, proactive_user_text
from core.usage import UsageRecorder
from services.character_store import LoadedPack, load_character_pack
from services.chat.memory_bridge import ChatMemoryBridge
from services.chat.stream_runner import ChatStreamRunner
from services.llm_ports import ClientFactory, Sleep

LOGGER = get_logger("sidecar.services.chat")

#: 没配端点时的提示（§6.3 的配置来自 .env，见仓库根 .env.example）
USER_HINT_NOT_CONFIGURED = (
    "还没有配置模型服务：请在 .env 里填 DESKPET_LLM_BASE_URL、"
    "DESKPET_LLM_API_KEY、DESKPET_LLM_MODEL"
)
USER_HINT_PACK_MISSING = "找不到这个角色包，或者角色包格式有问题"


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
        timeline: CompressionScheduler | None = None,
        graph: CompressionScheduler | None = None,
        behavior: BehaviorScheduler | None = None,
        now: Callable[[], float] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._llm = llm
        self._characters_dir = characters_dir
        self._sleep = sleep or asyncio.sleep
        # 使用统计（§6.9）：记事实而不落盘，写盘时机由 UsageService 决定；None = 不记录
        self._usage = usage
        # 环境事件（§6.8）：提示词只注入仍然有效的环境事实；断网登记与撤销在 runner 里
        self._env = env
        # 此刻状态（F8 验收 2）：时间与情绪可注入，单测才能复现同一段提示词
        self._now = now or time.time
        self._rng = rng or random.Random()
        # 记忆读写与收尾排期都收在 bridge 里（§6.4）；每个依赖都可为 None，由它自己兜
        self._memory = ChatMemoryBridge(
            memory=memory,
            summarizer=summarizer,
            timeline=timeline,
            graph=graph,
            behavior=behavior,
            now=self._now,
        )
        # 流式降级 / 重试 / 超时都在 runner 里（§6.7）
        self._runner = ChatStreamRunner(
            llm=llm,
            client_factory=client_factory or self._build_client,
            sleep=self._sleep,
            usage=usage,
            env=env,
        )

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
            (
                LlmEndpoint(
                    base_url=url,
                    api_key=api_key,
                    model=model,
                    preset=self._llm.preset if label != "local" else "",
                ),
                label,
            )
            for url, api_key, model, label in self._llm.endpoint_specs()
        )

    async def stream_events(self, request: ChatStreamRequest) -> AsyncIterator[LlmEvent]:
        """本轮会话的事件流；任何失败都收敛成 ErrorEvent + EndEvent（HTTP 层已发 200）。"""
        endpoints = self.endpoints()
        if not endpoints:
            yield ErrorEvent(
                code=CODE_LLM_BAD_RESPONSE,
                user_hint=USER_HINT_NOT_CONFIGURED,
                recoverable=False,
                detail=manual_error_detail(
                    "没有可用的模型端点（DESKPET_LLM_BASE_URL / API_KEY / MODEL 未配置齐全）"
                ),
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
                code=exc.code,
                user_hint=exc.user_hint or USER_HINT_PACK_MISSING,
                recoverable=False,
                detail=build_error_detail(exc),
            )
            yield EndEvent()
            return

        # 互动轮（部位点击）没有台词：把互动写成人话，当本轮的用户消息（T2.3-C2b）
        if request.proactive:
            user_text = proactive_user_text(pack.card.first_mes, request.proactive_kind)
        else:
            user_text = build_user_text(request.text, self._interaction_of(request))
        moment = self._now()
        state = self._memory.load_state(
            request.char_id, relationship=pack.card.relationship_initial, now=moment
        )
        # 先取记忆再组装提示词：本轮这句还没入库，所以检索不到自己（§6.4）
        recall = await self._memory.recall(request, user_text, mood_score=mood_valence(state.mood))
        # 状态跨轮次持续；心情只随时间段缓慢变化，不再每轮随机抽。
        variation = state.render(now=moment)
        # F9：只把仍然有效的环境事实注入提示词；user_hint 永不进入（render_facts 的边界）。
        active_events = getattr(self._env, "active", None)
        state_facts = render_character_facts(active_events()) if callable(active_events) else ()
        messages = build_messages(
            pack.card,
            user_text=user_text,
            screen_text=request.screen_text,
            language=pack.card.language,
            emotion_labels=tuple(pack.emotions.keys()),
            variation=variation,
            recall=recall,
            app_context=request.app_context,
            state_facts=state_facts,
            proactive=request.proactive,
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
                "interaction": (
                    request.interaction.regions[0].id
                    if request.interaction and request.interaction.regions
                    else ""
                ),
                "interaction_gesture": request.interaction.gesture if request.interaction else "",
                "interaction_count": request.interaction.count if request.interaction else 0,
            },
        )
        self._record_turn(request)
        spoken: list[str] = []
        facts: list[MemoryDraft] = []
        open_loops: list[str] = []
        try:
            async for event in self._runner.stream_with_fallback(
                endpoints, messages, request, memory_tokens=recall.tokens
            ):
                self._memory.collect(event, spoken, facts, open_loops)
                yield event
        finally:
            # 无论正常收尾、模型报错还是被用户打断，已经发生的事都记下来（§6.4）
            self._memory.save_turn(request, user_text, spoken, facts, open_loops)
            self._memory.save_state(
                state,
                request=request,
                user_text=user_text,
                spoke=bool(spoken),
                open_loops=open_loops,
                now=moment,
            )
            # 阶梯压缩 / 时间线 / 图谱 / 行为观察：只排后台任务，不阻塞这一轮（§6.4）
            self._memory.schedule_followups(request.char_id)
        if self._usage is not None:
            # 批量写盘机会：攒够一个窗口（默认 5 分钟）才真的写，避免逐条消息写盘
            await self._usage.flush_if_due()

    @staticmethod
    def _interaction_of(request: ChatStreamRequest) -> InteractionEvent | None:
        """把契约里的互动事实映射成 core 的纯类型（services 是唯一同时认识两边的层）。"""
        interaction = request.interaction
        if interaction is None:
            return None
        return InteractionEvent(
            gesture=interaction.gesture,
            region_names=tuple(region.name for region in interaction.regions),
            count=interaction.count,
            duration_ms=interaction.duration_ms,
        )

    def record_interrupt(self, session_id: str) -> None:
        """记一次打断（api 层在客户端断连或本机打断时调用，§6.9 的 interrupt_count）。"""
        if self._usage is not None:
            self._usage.record_interrupt(session_id)

    def _record_turn(self, request: ChatStreamRequest) -> None:
        """把「这一轮用户输入」记进使用统计（voice / text 分流，§6.9）。

        互动轮（部位点击）没有台词，不算一条用户消息：它只进 usage.db 的 char_hits（T2.3-C2b）。
        """
        if self._usage is None:
            return
        if not request.text.strip():
            return
        self._usage.record_turn(
            request.session_id,
            request.char_id,
            voice=request.input_mode == "voice",
        )

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


def build_chat_service(
    settings: Settings,
    *,
    usage: UsageRecorder | None = None,
    env: EnvEventReporter | None = None,
    memory: MemoryGateway | None = None,
    summarizer: CompressionScheduler | None = None,
    timeline: CompressionScheduler | None = None,
    graph: CompressionScheduler | None = None,
    behavior: BehaviorScheduler | None = None,
) -> ChatService:
    """组合根用的便捷构造：从 Settings 取 LLM 配置与角色包目录，并接上统计、事件与记忆。"""
    return ChatService(
        llm=settings.llm,
        characters_dir=settings.characters_dir,
        usage=usage,
        env=env,
        memory=memory,
        summarizer=summarizer,
        timeline=timeline,
        graph=graph,
        behavior=behavior,
    )


__all__ = [
    "USER_HINT_NOT_CONFIGURED",
    "USER_HINT_PACK_MISSING",
    "ChatService",
    "build_chat_service",
]
