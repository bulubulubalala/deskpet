"""文件职责：角色持久状态（core/character_state.py）的纯逻辑测试。"""

from __future__ import annotations

import time

from core.character_state import CharacterState, OpenLoop, mood_for_hour


def _moment(hour: int) -> float:
    return time.mktime((2026, 1, 1, hour, 0, 0, 0, 0, -1))


def test_seed_uses_relationship_and_time_of_day() -> None:
    state = CharacterState.seed("amber", relationship=0.7, now=_moment(3))

    assert state.relationship == 0.7
    assert "凌晨" in state.render(now=_moment(3))
    assert "心里装着自己的事" in state.mood


def test_render_is_stable_inside_same_time_bucket() -> None:
    state = CharacterState.seed("amber", now=_moment(10)).render(now=_moment(10))
    same = CharacterState.seed("amber", now=_moment(11)).render(now=_moment(11))

    assert state == same


def test_user_turn_advances_relationship_and_topics() -> None:
    state = CharacterState.seed("amber", relationship=0.5, now=_moment(10))
    next_state = state.after_user_turn("今天面试完了，有点累", now=_moment(10) + 5)

    assert next_state.relationship > state.relationship
    assert next_state.recent_topics == ("今天面试完了，有点累",)
    assert next_state.last_user_at == _moment(10) + 5


def test_recent_topics_are_deduplicated_and_bounded() -> None:
    state = CharacterState.seed("amber", now=_moment(10))
    for index in range(8):
        state = state.after_user_turn("话题" + str(index), now=_moment(10) + index)

    assert len(state.recent_topics) == 5
    assert state.recent_topics[-1] == "话题7"


def test_open_loops_render_when_due() -> None:
    state = CharacterState.seed("amber", now=_moment(10)).with_open_loop(
        "问他面试结果", due_at=_moment(11), now=_moment(10)
    )

    assert "问他面试结果" not in state.render(now=_moment(10))
    assert "问他面试结果" in state.render(now=_moment(11))


def test_ignored_proactive_increases_streak_and_responded_resets() -> None:
    state = CharacterState.seed("amber", now=_moment(10))
    ignored = state.after_proactive_outcome(responded=False, now=_moment(10) + 1)
    ignored = ignored.after_proactive_outcome(responded=False, now=_moment(10) + 2)
    responded = ignored.after_proactive_outcome(responded=True, now=_moment(10) + 3)

    assert ignored.proactive_ignored_streak == 2
    assert responded.proactive_ignored_streak == 0


def test_state_serialization_keeps_open_loops() -> None:
    state = CharacterState.seed("amber", now=_moment(10)).with_open_loop(
        "问他面试结果", due_at=_moment(12), now=_moment(10)
    )
    relation, mood, last_seen, last_proactive, ignored, updated = state.to_storage()
    loaded = CharacterState.from_storage(
        "amber",
        relation_json=relation,
        mood_json=mood,
        last_seen_ts=last_seen,
        last_proactive_ts=last_proactive,
        ignored_streak=ignored,
        updated_at=updated,
    )

    assert loaded.open_loops == (
        OpenLoop("问他面试结果", due_at=_moment(12), created_at=_moment(10)),
    )


def test_mood_for_hour_covers_the_day() -> None:
    assert "心情不错" in mood_for_hour(7)
    assert "情绪平平" in mood_for_hour(12)
    assert "有点好奇" in mood_for_hour(19)
    assert "有点倦" in mood_for_hour(23)
