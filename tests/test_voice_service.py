"""文件职责：VoiceService 的用例层测试（活动进出与取消语义，PLAN T1.6）。

依赖方向：tests -> services + core；不碰 HTTP。
谁调用：pytest。

覆盖重点：上下文管理器保证异常路径也注销活动、取消会作废在途结果（打断竞态）、
空闲打断是空操作。
"""

from __future__ import annotations

import pytest

from services.voice_service import VoiceService, build_voice_service


async def test_activity_registers_thinking_and_releases() -> None:
    service = VoiceService()

    async with service.activity("chat") as generation:
        assert service.state() == "thinking"
        assert service.is_cancelled(generation) is False

    assert service.state() == "idle"


async def test_activity_releases_on_exception() -> None:
    """错误路径必须复位（§6.7）：异常穿透上下文管理器时活动照样注销。"""
    service = VoiceService()

    with pytest.raises(RuntimeError):
        async with service.activity("tts"):
            assert service.state() == "speaking"
            raise RuntimeError("引擎炸了")

    assert service.state() == "idle"


async def test_nested_activities_keep_priority() -> None:
    service = VoiceService()

    async with service.activity("chat"):
        assert service.state() == "thinking"
        async with service.activity("tts"):
            assert service.state() == "speaking"
        assert service.state() == "thinking"

    assert service.state() == "idle"


async def test_cancel_during_asr_discards_in_flight_result() -> None:
    """竞态用例「ASR 正在出字时取消」：结果回来时 generation 已作废。"""
    service = VoiceService()

    async with service.activity("asr") as generation:
        assert service.state() == "thinking"
        service.interrupt("hotkey")
        assert service.snapshot().state == "cancelling"
        assert service.is_cancelled(generation) is True

    assert service.state() == "idle"


async def test_cancel_during_playback_then_listen() -> None:
    """竞态用例「播放中取消」：打断后用户立刻开口，状态只留 listening。"""
    service = VoiceService()

    async with service.activity("tts"):
        service.interrupt("voice_key")
        service.listen_start()
        assert service.state() == "listening"

    assert service.state() == "listening"

    service.listen_stop()
    assert service.state() == "idle"


async def test_interrupt_while_idle_is_noop() -> None:
    service = VoiceService()

    before = service.generation()

    assert service.interrupt("misclick") == before
    assert service.state() == "idle"


def test_build_voice_service_defaults_to_idle() -> None:
    service = build_voice_service()

    assert service.state() == "idle"
    assert service.snapshot().activities == ()
