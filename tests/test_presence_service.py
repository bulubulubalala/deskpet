"""在场感知与主动决策（services/presence_service.py）的行为测试。"""

from __future__ import annotations

import time
from pathlib import Path

from contracts.api_models import PresenceRequest
from core.character_state import CharacterState
from core.env_events import EVENT_PRESENCE_IDLE_LONG, EVENT_TIME_LATE_NIGHT, EnvEventBus
from services.presence_service import PresenceService

CHARACTERS_DIR = Path(__file__).resolve().parents[1] / "characters"
CHAR = "amber"
NOW = 1_700_000_000.0
NIGHT = time.mktime((2026, 1, 1, 23, 0, 0, 0, 0, -1))


class FakeMemory:
    def __init__(self, state: CharacterState | None = None) -> None:
        self.state = state
        self.saved: list[CharacterState] = []

    def load_character_state(
        self, char_id: str, *, seed_relationship: float = 0.5, now: float = 0.0
    ) -> CharacterState:
        return self.state or CharacterState.seed(char_id, relationship=seed_relationship, now=now)

    def save_character_state(self, state: CharacterState) -> None:
        self.state = state
        self.saved.append(state)


def _request(**overrides: object) -> PresenceRequest:
    base: dict[str, object] = {
        "char_id": CHAR,
        "window_visible": True,
        "window_minimized": False,
        "window_focused": True,
        "idle_seconds": 0.0,
        "input_mode": "text",
        "turn_active": False,
        "quiet_hours": False,
        "screen_changed": False,
        "screen_text": "",
        "mic_busy": False,
    }
    base.update(overrides)
    return PresenceRequest(**base)  # type: ignore[arg-type]


def _service(memory: FakeMemory) -> PresenceService:
    return PresenceService(
        memory=memory,  # type: ignore[arg-type]
        env=EnvEventBus(now=lambda: NOW),
        characters_dir=CHARACTERS_DIR,
        now=lambda: NOW,
    )


def test_minimized_window_never_speaks() -> None:
    decision = _service(FakeMemory()).apply(
        _request(window_minimized=True, screen_changed=True, screen_text="窗口里有新消息")
    )

    assert decision.proactive is False
    assert decision.reason == "window_hidden"


def test_quiet_hours_and_busy_user_are_hard_gates() -> None:
    service = _service(FakeMemory())

    assert service.apply(_request(quiet_hours=True)).proactive is False
    assert service.apply(_request(turn_active=True)).proactive is False
    assert service.apply(_request(input_mode="voice")).proactive is False
    assert service.apply(_request(mic_busy=True)).proactive is False


def test_screen_change_can_trigger_a_short_comment() -> None:
    memory = FakeMemory(CharacterState.seed(CHAR, relationship=0.6, now=NOW))
    decision = _service(memory).apply(
        _request(screen_changed=True, screen_text="编辑器里有一个没保存的报错")
    )

    assert decision.proactive is True
    assert decision.kind == "screen_comment"
    assert memory.state is not None
    assert memory.state.last_proactive_kind == "screen_comment"


def test_cooldown_blocks_repeated_proactive_speech() -> None:
    state = CharacterState.seed(CHAR, relationship=0.6, now=NOW).after_proactive(
        "screen_comment", now=NOW - 60
    )
    decision = _service(FakeMemory(state)).apply(
        _request(screen_changed=True, screen_text="又变了")
    )

    assert decision.proactive is False
    assert decision.reason == "cooldown"


def test_ignored_proactive_enters_backoff() -> None:
    state = CharacterState.seed(CHAR, relationship=0.6, now=NOW).after_proactive(
        "idle_checkin", now=NOW - 301
    )
    memory = FakeMemory(state)
    decision = _service(memory).apply(_request(idle_seconds=1800))

    assert decision.proactive is False
    assert memory.state is not None
    assert memory.state.proactive_ignored_streak == 1


def test_idle_and_late_night_events_are_reported_and_cleared() -> None:
    bus = EnvEventBus(now=lambda: NIGHT)
    service = PresenceService(
        memory=FakeMemory(),  # type: ignore[arg-type]
        env=bus,
        characters_dir=CHARACTERS_DIR,
        now=lambda: NIGHT,
    )

    service.apply(_request(idle_seconds=1800))
    assert EVENT_PRESENCE_IDLE_LONG in {event.id for event in bus.active(now=NIGHT)}
    assert EVENT_TIME_LATE_NIGHT in {event.id for event in bus.active(now=NIGHT)}

    service.apply(_request(idle_seconds=0, window_minimized=True))
    assert bus.active(now=NIGHT) == ()


def test_first_meeting_with_idle_window_uses_greeting() -> None:
    state = CharacterState.seed(CHAR, relationship=0.55, now=NOW)
    decision = _service(FakeMemory(state)).apply(_request(idle_seconds=120))

    assert decision.proactive is True
    assert decision.kind == "greet_absence"


def test_hourly_cap_blocks_third_proactive_in_same_hour() -> None:
    state = CharacterState.seed(CHAR, relationship=0.6, now=NIGHT)
    state = state.after_proactive("idle_checkin", now=NIGHT + 10)
    state = state.after_proactive("idle_checkin", now=NIGHT + 20)
    service = PresenceService(
        memory=FakeMemory(state),  # type: ignore[arg-type]
        env=EnvEventBus(now=lambda: NIGHT + 1300),
        characters_dir=CHARACTERS_DIR,
        now=lambda: NIGHT + 1300,
    )
    decision = service.apply(_request(idle_seconds=1800))
    assert decision.proactive is False
    assert decision.reason == "hourly_cap"
