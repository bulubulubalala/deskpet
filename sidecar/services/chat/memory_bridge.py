"""文件职责：一轮对话与「记忆」之间的全部往来（读写、角色状态、收尾排期）（§6.4）。

为什么单独一层：对话主流程只该关心「这一轮说什么」，不该关心「记忆存哪、哪几个后台任务
要排、哪些能力是可选的」。原先这些散落在 ChatService 的十二个私有方法里，还要用 getattr
试探记忆通道支不支持角色状态与待办，读代码时很难分清哪部分是「对话」、哪部分是「记忆」。

可选能力（角色状态、待办）在这一层用 getattr 试探：老替身没有这两个方法时，状态退回种子、
待办静默跳过——对话本身不受影响，这也正是 §6.4「记忆是增强项」的落点。

依赖方向：services -> core / contracts；不 import adapters、api。
谁调用：services/chat/service.py 的 ChatService。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from contracts.api_models import ChatStreamRequest
from contracts.events import LlmEvent, MemoryEvent, SentenceEvent
from core.character_state import CharacterState
from core.logging import get_logger, log_event
from core.memory import (
    BehaviorScheduler,
    CompressionScheduler,
    MemoryDraft,
    MemoryGateway,
    RecallContext,
)

LOGGER = get_logger("sidecar.services.chat")


@dataclass(frozen=True)
class _Follower:
    """一个「本轮结束后排一次后台整理」的任务。

    T2.1b 阶梯压缩 / T2.33 时间线 / T2.37 图谱 / T2.1c 行为观察——四件事的做法一模一样：
    有就排、排失败只记日志、绝不影响这一轮。用一张表收掉四份复制粘贴的 try/except。
    """

    scheduler: CompressionScheduler | BehaviorScheduler | None
    event: str
    message: str


class ChatMemoryBridge:
    """一轮对话要读写的全部记忆侧动作；所有外部依赖从构造函数注入（可单测）。"""

    def __init__(
        self,
        *,
        memory: MemoryGateway | None = None,
        summarizer: CompressionScheduler | None = None,
        timeline: CompressionScheduler | None = None,
        graph: CompressionScheduler | None = None,
        behavior: BehaviorScheduler | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        # 记忆（§6.4）：读写都吞失败；None = 这个进程没有记忆
        self._memory = memory
        # 此刻状态（F8 验收 2）：时间可注入，单测才能复现同一条时间线
        self._now = now or time.time
        # 收尾后 fire-and-forget 的四件后台整理，元组顺序即执行顺序：None = 不启用
        self._followers = (
            _Follower(summarizer, "chat.compress_failed", "安排记忆压缩失败，本轮忽略"),
            _Follower(
                timeline, "chat.timeline_schedule_failed", "时间线整理排期失败，本轮不受影响"
            ),
            _Follower(graph, "chat.graph_schedule_failed", "记忆图谱排期失败，本轮不受影响"),
            _Follower(behavior, "chat.observe_failed", "安排行为观察刷新失败，本轮忽略"),
        )

    async def recall(
        self, request: ChatStreamRequest, query: str, *, mood_score: float = 0.0
    ) -> RecallContext:
        """取本轮要注入的记忆；没有记忆通道就返回空上下文（提示词与历史行为完全一致）。

        query 用拼好的本轮用户文本：互动轮就是那句互动事实，这样「他戳了你的脸」也能命中相关记忆。
        """
        if self._memory is None:
            return RecallContext()
        vector = None
        embed = getattr(self._memory, "embed_query", None)
        if callable(embed):
            vector = await embed(query)
        return self._memory.recall(
            char_id=request.char_id,
            query=query,
            now=self._now(),
            query_vector=vector,
            mood_valence=mood_score,
        )

    def load_state(self, char_id: str, *, relationship: float, now: float) -> CharacterState:
        """读取角色状态；旧测试替身没有状态接口时退回种子状态。"""
        loader = getattr(self._memory, "load_character_state", None)
        if not callable(loader):
            return CharacterState.seed(char_id, relationship=relationship, now=now)
        try:
            state = loader(char_id, seed_relationship=relationship, now=now)
        except Exception as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="sidecar.services.chat",
                event="chat.state_read_failed",
                message="读取角色状态失败，本轮按种子状态继续",
                fields={"reason": type(exc).__name__},
            )
            return CharacterState.seed(char_id, relationship=relationship, now=now)
        return (
            state
            if isinstance(state, CharacterState)
            else CharacterState.seed(char_id, relationship=relationship, now=now)
        )

    def save_state(
        self,
        state: CharacterState,
        *,
        request: ChatStreamRequest,
        user_text: str,
        spoke: bool,
        open_loops: Sequence[str],
        now: float,
    ) -> None:
        """把本轮变化写回；状态写失败不影响对话。"""
        saver = getattr(self._memory, "save_character_state", None)
        if not callable(saver):
            return
        next_state = state.refresh(now)
        if request.proactive:
            next_state = next_state.after_proactive(request.proactive_kind or "proactive", now=now)
        else:
            next_state = next_state.after_user_turn(user_text, now=now)
        for loop in open_loops:
            next_state = next_state.with_open_loop(loop, due_at=now + 2 * 3600.0, now=now)
        if (request.proactive and request.proactive_kind == "followup_open_loop" and spoke) or (
            not request.proactive
            and state.last_proactive_kind == "followup_open_loop"
            and next_state.last_user_at > state.last_proactive_at
        ):
            due = next_state.due_open_loops(now)
            if due:
                next_state = next_state.without_open_loop(due[-1].text)
        if spoke:
            next_state = next_state.after_assistant_turn(now=now)
        try:
            saver(next_state)
        except Exception as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="sidecar.services.chat",
                event="chat.state_write_failed",
                message="保存角色状态失败，本轮对话不受影响",
                fields={"reason": type(exc).__name__},
            )

    def collect(
        self,
        event: LlmEvent,
        spoken: list[str],
        facts: list[MemoryDraft],
        open_loops: list[str],
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
            if event.follow_up:
                open_loops.append(event.text)

    def save_turn(
        self,
        request: ChatStreamRequest,
        user_text: str,
        spoken: Sequence[str],
        facts: Sequence[MemoryDraft],
        open_loops: Sequence[str] = (),
    ) -> None:
        """一轮结束后写 L0（§6.4）：用户这句 + 播出去的台词 + 模型标出的长期事实。

        存的是 user_text（互动轮就是「他戳了一下…」那句）——那是模型当时真正看到的 user turn，
        不写它历史就断了；屏幕文本不入库：OCR 是**不可信输入**，记住了只会污染以后的每一轮（§7.4）。
        写失败只记日志——记忆是增强项，绝不能因为它把这轮请求搞崩。
        """
        if self._memory is None:
            return
        moment = self._now()
        try:
            if not request.proactive:
                self._memory.record_message(
                    char_id=request.char_id,
                    session_id=request.session_id,
                    role="user",
                    text=user_text,
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
            if open_loops:
                recorder = getattr(self._memory, "record_intentions", None)
                if callable(recorder):
                    recorder(char_id=request.char_id, texts=list(open_loops), now=moment)
        except Exception as exc:  # 记忆写失败绝不能打断对话（§6.7 A 级）
            log_event(
                LOGGER,
                logging.ERROR,
                module="sidecar.services.chat",
                event="chat.memory_write_failed",
                message="记忆写入失败，这一轮不会影响对话本身",
                fields={"reason": type(exc).__name__, "error": str(exc)},
            )

    def schedule_followups(self, char_id: str) -> None:
        """对话收尾后依次排四件后台整理；任何一件出问题都只记日志，绝不影响本轮。

        只排任务、不等待：它们是增强项，慢一点没关系，卡住这一轮才是事故（§6.4）。
        """
        for follower in self._followers:
            if follower.scheduler is None:
                continue
            try:
                follower.scheduler.schedule(char_id)
            except Exception as exc:  # 兜底：整理是增强项（§6.4）
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="sidecar.services.chat",
                    event=follower.event,
                    message=follower.message,
                    fields={
                        "char_id": char_id,
                        "reason": type(exc).__name__,
                        "error": str(exc),
                    },
                )


__all__ = ["ChatMemoryBridge"]
