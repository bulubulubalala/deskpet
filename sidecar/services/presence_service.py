"""在场感知与主动决策（F9 / F5）。

主进程只上报窗口、空闲、输入模式、屏幕摘要等事实；这里负责：
- 把角色能体验到的状态写进 EnvEventBus；
- 读取 CharacterState 与角色卡，决定此刻要不要主动开口；
- 被忽略后自动退避。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from contracts.api_models import PresenceRequest, PresenceResponse
from core.character_state import CharacterState
from core.env_events import (
    EVENT_MIC_BUSY,
    EVENT_PRESENCE_IDLE_LONG,
    EVENT_TIME_LATE_NIGHT,
    EnvEventBus,
)
from core.logging import get_logger, log_event
from services.character_store import load_character_pack
from services.memory_service import MemoryService

LOGGER = get_logger("services.presence_service")

#: 空闲多久开始算「有一阵子没动」
IDLE_EVENT_SECONDS = 1800.0
#: 主动发言的基础冷却；被忽略后按 2 倍退避
PROACTIVE_COOLDOWN_S = 20 * 60.0
#: 主动后多久没有回应算忽略
IGNORED_AFTER_S = 300.0
#: 判断深夜的本地小时
LATE_NIGHT_START = 23
LATE_NIGHT_END = 5
#: 主动打分门槛
PROACTIVE_THRESHOLD = 0.55


@dataclass(frozen=True, slots=True)
class _Decision:
    speak: bool
    kind: str
    reason: str


class PresenceService:
    def __init__(
        self,
        *,
        memory: MemoryService,
        env: EnvEventBus,
        characters_dir: Path,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._memory = memory
        self._env = env
        self._characters_dir = characters_dir
        self._now = now or time.time

    def apply(self, request: PresenceRequest, *, now: float | None = None) -> PresenceResponse:
        moment = self._now() if now is None else now
        self._sync_events(request, moment)
        state = self._memory.load_character_state(
            request.char_id,
            seed_relationship=self._relationship_for(request.char_id),
            now=moment,
        )
        state, responded = self._settle_outcome(state, moment)
        decision = self._decide(request, state, moment)
        if responded:
            self._memory.save_character_state(state)
        if not decision.speak:
            return PresenceResponse(reason=decision.reason)
        next_state = state.after_proactive(decision.kind, now=moment)
        self._memory.save_character_state(next_state)
        log_event(
            LOGGER,
            logging.INFO,
            module="services.presence_service",
            event="presence.proactive",
            message="主动开口",
            fields={"char_id": request.char_id, "kind": decision.kind, "reason": decision.reason},
        )
        return PresenceResponse(proactive=True, kind=decision.kind, reason=decision.reason)

    def _sync_events(self, request: PresenceRequest, moment: float) -> None:
        present = request.window_visible and not request.window_minimized
        if present and request.idle_seconds >= IDLE_EVENT_SECONDS:
            self._env.report(
                EVENT_PRESENCE_IDLE_LONG,
                fact="对方已经有一阵子没动了。",
                dedup_key="presence:idle",
            )
        else:
            self._env.clear(event_id=EVENT_PRESENCE_IDLE_LONG)
        hour = time.localtime(moment).tm_hour
        late = hour >= LATE_NIGHT_START or hour < LATE_NIGHT_END
        if present and late:
            self._env.report(EVENT_TIME_LATE_NIGHT, fact="现在是深夜。", dedup_key="presence:night")
        else:
            self._env.clear(event_id=EVENT_TIME_LATE_NIGHT)
        if request.mic_busy:
            self._env.report(
                EVENT_MIC_BUSY,
                fact="麦克风正被别的程序占用。",
                dedup_key="presence:mic",
            )
        else:
            self._env.clear(event_id=EVENT_MIC_BUSY)

    def _settle_outcome(self, state: CharacterState, moment: float) -> tuple[CharacterState, bool]:
        if state.last_proactive_at <= 0:
            return state, False
        if state.last_user_at > state.last_proactive_at:
            if state.proactive_ignored_streak > 0:
                return (
                    state.after_proactive_outcome(responded=True, now=moment),
                    True,
                )
            return state, False
        if (
            state.proactive_ignored_streak == 0
            and moment - state.last_proactive_at >= IGNORED_AFTER_S
        ):
            return state.after_proactive_outcome(responded=False, now=moment), True
        return state, False

    def _decide(self, request: PresenceRequest, state: CharacterState, moment: float) -> _Decision:
        if not request.window_visible or request.window_minimized:
            return _Decision(False, "", "window_hidden")
        if request.quiet_hours:
            return _Decision(False, "", "quiet_hours")
        if request.mic_busy:
            return _Decision(False, "", "mic_busy")
        if request.turn_active or request.input_mode == "voice":
            return _Decision(False, "", "user_busy")

        hour_key = int(moment // 3600)
        if state.proactive_hour_key == hour_key and state.proactive_hour_count >= 2:
            return _Decision(False, "", "hourly_cap")

        card = self._card_proactive(request.char_id)
        cooldown = PROACTIVE_COOLDOWN_S * (2 ** min(state.proactive_ignored_streak, 2))
        if state.last_proactive_at > 0 and moment - state.last_proactive_at < cooldown:
            return _Decision(False, "", "cooldown")

        due = state.due_open_loops(moment)
        if due:
            return _Decision(True, "followup_open_loop", "open_loop_due")

        idle_norm = min(1.0, request.idle_seconds / IDLE_EVENT_SECONDS)
        screen_novel = 1.0 if request.screen_changed and request.screen_text.strip() else 0.0
        first_meeting = state.last_user_at <= 0
        absence = state.last_user_at > 0 and moment - state.last_user_at >= 4 * 3600
        if first_meeting and request.idle_seconds >= 120:
            return _Decision(True, "greet_absence", "first_meeting")
        if absence:
            return _Decision(True, "greet_absence", "long_absence")
        if state.open_loops:
            score = 0.45 * card + 0.25 * idle_norm + 0.15 * screen_novel + 0.15 * state.relationship
            if score >= PROACTIVE_THRESHOLD:
                return _Decision(True, "idle_checkin", "open_loop_waiting")
        if screen_novel and card >= 0.25:
            return _Decision(True, "screen_comment", "screen_changed")
        score = 0.55 * card + 0.35 * idle_norm + 0.10 * state.relationship
        if idle_norm >= 0.4 and score >= PROACTIVE_THRESHOLD:
            return _Decision(True, "idle_checkin", "idle")
        return _Decision(False, "", "not_enough_reason")

    def _card_proactive(self, char_id: str) -> float:
        try:
            pack = load_character_pack(self._characters_dir / char_id)
        except Exception:
            return 0.4
        return pack.card.proactive

    def _relationship_for(self, char_id: str) -> float:
        try:
            pack = load_character_pack(self._characters_dir / char_id)
        except Exception:
            return 0.5
        return pack.card.relationship_initial
