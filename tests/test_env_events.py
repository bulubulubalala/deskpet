"""文件职责：单测 core/env_events.py 的事件契约（需求 §6.8）——去重、过期、事实与提示分离。

依赖方向：tests -> core；纯逻辑，无 IO、无硬件。
谁调用：pytest。

重点盯住两件事：同一条件重复上报只留一条（since 不刷掉），以及
render_facts() 只读 fact、**永不读出 user_hint**。
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from core.env_events import (
    EVENT_ASR_EMPTY,
    EVENT_IDS,
    EVENT_NET_DOWN,
    EVENT_PRESENCE_IDLE_LONG,
    EVENT_TTS_FAILED,
    LEVEL_A,
    LEVEL_B,
    EnvEvent,
    EnvEventBus,
    render_character_facts,
    render_facts,
)


class Clock:
    """可推进的假时钟：事件契约里 since / ttl 全靠它才可测。"""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _bus(clock: Clock) -> EnvEventBus:
    return EnvEventBus(now=clock, instance="test")


def test_event_ids_match_the_contract() -> None:
    """§6.8 的十种事件类型，一种不多一种不少（契约冻结）。"""
    assert set(EVENT_IDS) == {
        "tts.failed",
        "asr.empty",
        "net.down",
        "mic.busy",
        "screen.ocr_failed",
        "mem.readonly",
        "mem.key_invalid",
        "engine.not_loaded",
        "presence.idle_long",
        "time.late_night",
    }


def test_report_fills_defaults() -> None:
    clock = Clock()
    event = _bus(clock).report(EVENT_ASR_EMPTY, fact="这一轮没听清用户说话")

    assert event.id == EVENT_ASR_EMPTY
    assert event.level == LEVEL_A
    assert event.ttl == 120.0
    assert event.dedup_key == "asr.empty@test"
    assert event.since == 1000.0
    assert event.user_hint == ""


def test_unknown_event_id_is_rejected() -> None:
    with pytest.raises(ValueError, match="未知的环境事件类型"):
        _bus(Clock()).report("tts.exploded", fact="x")


def test_same_dedup_key_keeps_one_event_and_original_since() -> None:
    """同一条件反复上报：只留一条，since 停在第一次（§6.8 的「事件开始时间」）。"""
    clock = Clock()
    bus = _bus(clock)
    bus.report(EVENT_NET_DOWN, fact="第一次连不上")
    clock.advance(30)
    event = bus.report(EVENT_NET_DOWN, fact="还是连不上")

    active = bus.active()
    assert len(active) == 1
    assert active[0].fact == "还是连不上"
    assert event.since == 1000.0


def test_lapsed_condition_starts_a_fresh_since() -> None:
    """上一次已经过期，再出事就是新的一次（否则角色会被一段旧状态长期"缠住"）。"""
    clock = Clock()
    bus = _bus(clock)
    bus.report(EVENT_NET_DOWN, fact="断了", ttl_s=10.0)
    clock.advance(60)
    event = bus.report(EVENT_NET_DOWN, fact="又断了")

    assert event.since == 1060.0
    assert len(bus.active()) == 1


def test_ttl_expiry_marks_recovery() -> None:
    clock = Clock()
    bus = _bus(clock)
    bus.report(EVENT_TTS_FAILED, fact="合成失败", ttl_s=60.0)

    assert len(bus.active(now=1030.0)) == 1
    assert bus.active(now=1061.0) == ()
    assert bus.prune(now=1061.0) == 1
    assert bus.active(now=1030.0) == ()


def test_custom_dedup_key_groups_by_source() -> None:
    """同类事件来自不同来源时各留一条（去重键由上报方决定）。"""
    bus = _bus(Clock())
    bus.report(EVENT_NET_DOWN, fact="主端点不通", dedup_key="net.down:primary")
    bus.report(EVENT_NET_DOWN, fact="备用端点不通", dedup_key="net.down:fallback")

    assert {event.dedup_key for event in bus.active()} == {
        "net.down:primary",
        "net.down:fallback",
    }


def test_clear_by_event_id_and_by_key() -> None:
    bus = _bus(Clock())
    bus.report(EVENT_NET_DOWN, fact="主端点不通", dedup_key="net.down:primary")
    bus.report(EVENT_NET_DOWN, fact="备用端点不通", dedup_key="net.down:fallback")
    bus.report(EVENT_ASR_EMPTY, fact="没听清")

    assert bus.clear(dedup_key="net.down:primary") == 1
    assert bus.clear(event_id=EVENT_NET_DOWN) == 1
    assert bus.clear(event_id=EVENT_ASR_EMPTY) == 1
    assert bus.clear() == 0


def test_subscribe_receives_snapshots_and_can_unsubscribe() -> None:
    bus = _bus(Clock())
    seen: list[tuple[EnvEvent, ...]] = []
    unsubscribe = bus.subscribe(seen.append)

    bus.report(EVENT_ASR_EMPTY, fact="没听清")
    bus.clear(event_id=EVENT_ASR_EMPTY)
    unsubscribe()
    bus.report(EVENT_ASR_EMPTY, fact="又没听清")

    assert len(seen) == 2
    assert len(seen[0]) == 1
    assert seen[1] == ()


def test_render_facts_never_exposes_user_hint() -> None:
    """F9 的硬要求：排查指引只给 UI，绝不进提示词。"""
    bus = _bus(Clock())
    network = bus.report(
        EVENT_NET_DOWN,
        fact="连不上模型服务（网络不通）",
        user_hint="检查代理设置：http://localhost:10808",
    )
    tts = bus.report(
        EVENT_TTS_FAILED,
        fact="语音合成失败（DP-TTS-503）",
        user_hint="先启动 IndexTTS 适配器",
        level=LEVEL_B,
    )
    lines = render_facts([network, tts])
    joined = "\n".join(lines)

    assert "连不上模型服务（网络不通）" in joined
    assert "语音合成失败（DP-TTS-503）" in joined
    assert "检查代理设置" not in joined
    assert "先启动 IndexTTS 适配器" not in joined
    # 只改 user_hint 不影响渲染结果——这是「不进提示词」最直接的证据
    assert render_facts([replace(network, user_hint="换一段指引"), tts]) == lines


def test_character_facts_do_not_expose_internal_event_names() -> None:
    events = [
        EnvEvent(
            id=EVENT_TTS_FAILED,
            level=LEVEL_B,
            fact="语音合成失败（DP-TTS-503）",
            user_hint="先启动 IndexTTS 适配器",
            since=0.0,
            dedup_key="tts",
            ttl=60.0,
        ),
        EnvEvent(
            id=EVENT_PRESENCE_IDLE_LONG,
            level=LEVEL_A,
            fact="长时间无输入",
            user_hint="",
            since=0.0,
            dedup_key="idle",
            ttl=60.0,
        ),
    ]

    lines = render_character_facts(events)

    assert lines == ["你刚才想说话，但声音没能发出来。", "对方已经有一阵子没动了。"]
    assert all("DP-" not in line and "tts." not in line for line in lines)


def test_to_payload_matches_contract_fields() -> None:
    event = _bus(Clock()).report(EVENT_NET_DOWN, fact="断了", user_hint="检查网络")

    assert set(event.to_payload()) == {
        "id",
        "level",
        "fact",
        "user_hint",
        "since",
        "dedup_key",
        "ttl",
    }
