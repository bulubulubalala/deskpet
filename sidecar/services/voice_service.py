"""文件职责：语音状态机的用例编排（PLAN T1.6）。

依赖方向：services -> core + contracts；不 import adapters / api。
谁调用：api/chat.py、api/asr.py、api/tts.py 用 activity() 包住真实工作；
        services/health_service.py 读到同一份快照（由组合根注入 state 取值函数）。

为什么要有这一层：三个路由各自 begin/end 很容易漏掉某条异常路径；这里用异步上下文管理器
把 begin/end 收在一处，任何抛出都会走 finally，状态一定复位（需求 §6.7「不允许停在
speaking」）。同时统一在这里写状态相关日志，避免日志口径散落在各路由里。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from core.logging import get_logger, log_event
from core.voice_state import VoiceActivity, VoiceSnapshot, VoiceState, VoiceStateMachine

LOGGER = get_logger("sidecar.services.voice")


class VoiceService:
    """把「一段工作进出」翻译成状态迁移，并对外暴露取消代数。"""

    def __init__(self, machine: VoiceStateMachine | None = None) -> None:
        self._machine = machine or VoiceStateMachine()

    # ---- 只读 ----

    def state(self) -> VoiceState:
        """当前状态；供 /health 直接取用（不加载任何东西，满足 §6.3 的 10ms 口径）。"""
        return self._machine.state()

    def snapshot(self) -> VoiceSnapshot:
        """完整快照，日志与诊断用。"""
        return self._machine.snapshot()

    def generation(self) -> int:
        """当前取消代数。"""
        return self._machine.generation()

    def is_cancelled(self, generation: int) -> bool:
        """开工前取的 generation 是否已被一次打断作废。"""
        return self._machine.is_cancelled(generation)

    # ---- 工作进出 ----

    @asynccontextmanager
    async def activity(self, name: VoiceActivity) -> AsyncIterator[int]:
        """包住一段真实工作：进入即登记，退出（正常或异常）必定注销。

        产出开始时的 generation：调用方拿到结果后可用 is_cancelled() 判断这趟是否已作废。
        """
        generation = self._machine.generation()
        before = self._machine.state()
        self._machine.begin(name)
        self._log_transition("voice.activity_begin", before, name)
        try:
            yield generation
        finally:
            self._machine.end(name)
            self._log_transition("voice.activity_end", before, name)

    def listen_start(self) -> VoiceSnapshot:
        """用户按下语音键 / VAD 判定开口：进入 listening（并清掉上一次的取消标记）。"""
        before = self._machine.state()
        snapshot = self._machine.listen_start()
        self._log_transition("voice.listen_start", before, "listen_start", snapshot.state)
        return snapshot

    def listen_stop(self) -> VoiceSnapshot:
        """用户说完（送 ASR 前）：退出 listening。"""
        return self._machine.listen_stop()

    def interrupt(self, reason: str) -> int:
        """受理一次打断（热键 / 说话即打断 / 聊天框打字）：返回新的 generation。

        空闲时是空操作，不产生假取消——重复触发与误触都不会打断已经结束的东西。
        """
        before_generation = self._machine.generation()
        generation = self._machine.cancel(reason)
        if generation != before_generation:
            log_event(
                LOGGER,
                logging.INFO,
                module="sidecar.services.voice",
                event="voice.cancelled",
                message="受理一次语音打断",
                fields={"reason": reason, "generation": generation},
            )
        return generation

    def reset(self) -> VoiceSnapshot:
        """硬复位（错误路径兜底）：保证任何异常处理之后都不会停在 speaking / listening。"""
        return self._machine.reset()

    # ---- 内部 ----

    def _log_transition(
        self,
        event: str,
        before: VoiceState,
        activity: str,
        after: VoiceState | None = None,
    ) -> None:
        """记录一次状态迁移；DEBUG 级别，正常使用不刷日志。"""
        log_event(
            LOGGER,
            logging.DEBUG,
            module="sidecar.services.voice",
            event=event,
            message="语音状态迁移",
            fields={
                "activity": activity,
                "from": before,
                "to": after or self._machine.state(),
            },
        )


def build_voice_service(machine: VoiceStateMachine | None = None) -> VoiceService:
    """构造语音服务；组合根（sidecar/app.py）只调这里。"""
    return VoiceService(machine)
