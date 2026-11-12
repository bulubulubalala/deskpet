"""文件职责：语音状态机的纯逻辑测试（PLAN T1.6 / 需求 §4.3 / F2）。

依赖方向：tests -> core（纯逻辑）；不碰 HTTP、不加载模型、不需要麦克风与显卡。
谁调用：pytest。

覆盖重点：重叠活动不会互相覆盖、取消会作废在途结果、空闲取消是空操作（防连按/误触）、
以及任何路径退出活动后一定落回 idle（§6.7「不允许停在 speaking」）。
"""

from __future__ import annotations

from core.voice_state import VoiceStateMachine


def test_initial_state_is_idle() -> None:
    machine = VoiceStateMachine()

    assert machine.state() == "idle"
    assert machine.generation() == 0
    snapshot = machine.snapshot()
    assert snapshot.activities == ()
    assert snapshot.listening is False
    assert snapshot.cancel_reason == ""


def test_listening_flow() -> None:
    machine = VoiceStateMachine()

    machine.listen_start()
    assert machine.state() == "listening"

    machine.listen_stop()
    assert machine.state() == "idle"


def test_begin_activity_ends_listening() -> None:
    """开口之后开始干活：听音标志必须让位给 thinking，否则状态会自相矛盾。"""
    machine = VoiceStateMachine()

    machine.listen_start()
    machine.begin("asr")
    assert machine.state() == "thinking"
    assert machine.snapshot().listening is False

    machine.end("asr")
    assert machine.state() == "idle"


def test_tts_has_priority_over_chat() -> None:
    """LLM 还在推句子时 TTS 已经开始合成：状态必须是 speaking，且 chat 结束后不回落。"""
    machine = VoiceStateMachine()

    machine.begin("chat")
    assert machine.state() == "thinking"

    machine.begin("tts")
    assert machine.state() == "speaking"

    machine.end("tts")
    assert machine.state() == "thinking"

    machine.end("chat")
    assert machine.state() == "idle"


def test_duplicate_begin_is_idempotent() -> None:
    """连按语音键 / 重复触发不该让状态卡住：一次 end 就足以清掉。"""
    machine = VoiceStateMachine()

    machine.begin("asr")
    machine.begin("asr")
    machine.end("asr")

    assert machine.state() == "idle"


def test_cancel_while_speaking_waits_for_work_to_drain() -> None:
    machine = VoiceStateMachine()

    machine.begin("tts")
    generation = machine.cancel("hotkey")
    assert machine.state() == "cancelling"
    assert machine.snapshot().cancel_reason == "hotkey"

    machine.end("tts")
    assert machine.state() == "idle"
    assert machine.snapshot().cancel_reason == ""
    assert generation == 1


def test_cancel_when_idle_is_noop() -> None:
    """空闲取消不抬 generation：重复触发不会产生「假的取消」而丢掉正常结果。"""
    machine = VoiceStateMachine()

    generation = machine.cancel("double_click")

    assert generation == 0
    assert machine.state() == "idle"
    assert machine.snapshot().cancel_reason == ""


def test_cancel_invalidates_older_generation_only() -> None:
    machine = VoiceStateMachine()
    old_generation = machine.generation()

    machine.begin("asr")
    new_generation = machine.cancel("hotkey")

    assert new_generation == old_generation + 1
    assert machine.is_cancelled(old_generation) is True
    assert machine.is_cancelled(new_generation) is False


def test_cancel_while_only_listening_settles_immediately() -> None:
    """只在听音、没有在途工作时取消：直接回 idle，不留在 cancelling。"""
    machine = VoiceStateMachine()

    machine.listen_start()
    machine.cancel("hotkey")

    assert machine.state() == "idle"
    assert machine.snapshot().listening is False


def test_listen_start_clears_cancelling() -> None:
    """打断的终点就是用户开口：listen_start 必须把 cancelling 收掉。"""
    machine = VoiceStateMachine()

    machine.begin("tts")
    machine.cancel("hotkey")
    machine.listen_start()

    assert machine.state() == "listening"

    machine.end("tts")
    assert machine.state() == "listening"


def test_reset_clears_state_but_keeps_generation() -> None:
    machine = VoiceStateMachine()

    machine.begin("tts")
    machine.begin("chat")
    machine.listen_start()
    machine.cancel("hotkey")
    generation = machine.generation()

    machine.reset()

    assert machine.state() == "idle"
    assert machine.snapshot().activities == ()
    assert machine.snapshot().generation == generation


def test_snapshot_lists_activities_sorted() -> None:
    machine = VoiceStateMachine()

    machine.begin("tts")
    machine.begin("asr")
    machine.begin("chat")

    assert machine.snapshot().activities == ("asr", "chat", "tts")
