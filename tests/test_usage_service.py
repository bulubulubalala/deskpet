"""文件职责：单测 services/usage_service.py——内存账本、批量写、开关与失败兜底（§6.9）。

依赖方向：tests -> services / core / config；存储用内存假件（真 SQLite 的行为由
tests/test_usage_store.py 覆盖），因此不碰磁盘也不需要任何硬件。
谁调用：pytest。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from config import Settings
from core.usage import META_RECORDING_ENABLED, ProviderNames, SessionRow, day_key
from services.usage_service import UsageService, build_usage_service


class Clock:
    """可控时钟：now 传它，测试才能「快进」到空闲超时与 flush 窗口。"""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@dataclass
class FakeStore:
    """内存版 UsageStore：累加并记录调用，用来断言「写了几次、写了什么」。"""

    meta: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, SessionRow] = field(default_factory=dict)
    char_seconds: dict[str, float] = field(default_factory=dict)
    char_sessions: dict[str, int] = field(default_factory=dict)
    daily: dict[str, tuple[float, int, int]] = field(default_factory=dict)
    switches: list[tuple[float, str | None, str]] = field(default_factory=list)
    calls: list[str] = field(default_factory=list)
    fail_on: set[str] = field(default_factory=set)
    cleared: int = 0
    closed: bool = False

    def read_meta(self, key: str) -> str | None:
        self.calls.append("read_meta")
        if "read_meta" in self.fail_on:
            raise RuntimeError("meta 读不出来")
        return self.meta.get(key)

    def write_meta(self, key: str, value: str) -> None:
        self.calls.append("write_meta")
        self.meta[key] = value

    def write_session(self, row: SessionRow) -> None:
        self.calls.append("write_session")
        if "write_session" in self.fail_on:
            raise RuntimeError("磁盘满了")
        self.sessions[row.session_id] = row

    def add_char_usage(self, char_id: str, *, seconds: float, sessions: int, at: float) -> None:
        self.calls.append("add_char_usage")
        self.char_seconds[char_id] = self.char_seconds.get(char_id, 0.0) + seconds
        self.char_sessions[char_id] = self.char_sessions.get(char_id, 0) + sessions

    def add_daily(
        self, date: str, *, duration_sec: float, session_count: int, msg_count: int
    ) -> None:
        self.calls.append("add_daily")
        duration, sessions, messages = self.daily.get(date, (0.0, 0, 0))
        self.daily[date] = (
            duration + duration_sec,
            sessions + session_count,
            messages + msg_count,
        )

    def append_switch(self, at: float, from_char_id: str | None, to_char_id: str) -> None:
        self.calls.append("append_switch")
        self.switches.append((at, from_char_id, to_char_id))

    def clear_usage(self) -> None:
        self.cleared += 1
        self.sessions.clear()
        self.char_seconds.clear()
        self.char_sessions.clear()
        self.daily.clear()
        self.switches.clear()

    def close(self) -> None:
        self.closed = True


def _service(
    store: FakeStore | None = None,
    clock: Clock | None = None,
    providers: ProviderNames | None = None,
    **kwargs: float,
) -> tuple[UsageService, FakeStore, Clock]:
    fake = store or FakeStore()
    time_source = clock or Clock()
    return UsageService(fake, now=time_source, providers=providers, **kwargs), fake, time_source


async def test_record_turn_then_flush_writes_all_tables() -> None:
    usage, store, clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    clock.advance(3.0)
    usage.record_turn("s1", "amber", voice=True)

    assert await usage.flush() is True

    row = store.sessions["s1"]
    assert (row.char_id, row.msg_count, row.text_msg_count, row.voice_msg_count) == (
        "amber",
        2,
        1,
        1,
    )
    assert row.duration_sec == 3.0
    assert row.ended_at is None  # 会话还开着：空闲超时或退出时才收尾
    assert store.char_seconds["amber"] == 3.0
    assert store.char_sessions["amber"] == 1
    assert store.daily == {day_key(clock.t): (3.0, 1, 2)}


async def test_flush_without_new_facts_is_noop() -> None:
    usage, store, _clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is True

    before = len(store.calls)
    assert await usage.flush() is False
    assert len(store.calls) == before  # 没有新事实就一个字都不写


async def test_increments_are_not_double_counted() -> None:
    """char_usage / daily 是累加表：第二次 flush 只能带增量。"""
    usage, store, clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    clock.advance(4.0)
    assert await usage.flush() is True

    usage.record_turn("s1", "amber", voice=False)
    clock.advance(6.0)
    assert await usage.flush() is True

    assert store.char_seconds["amber"] == 10.0
    assert store.sessions["s1"].duration_sec == 10.0


async def test_idle_session_is_closed_and_removed() -> None:
    usage, store, clock = _service(idle_timeout_s=10.0)
    usage.record_turn("s1", "amber", voice=False)
    assert usage.open_session_count == 1

    clock.advance(11.0)
    assert await usage.flush() is True

    assert usage.open_session_count == 0
    assert store.sessions["s1"].ended_at == clock.t


async def test_flush_if_due_respects_the_window() -> None:
    usage, store, clock = _service(flush_interval_s=300.0)
    usage.record_turn("s1", "amber", voice=False)

    clock.advance(299.0)
    assert await usage.flush_if_due() is False
    assert store.sessions == {}

    clock.advance(2.0)
    assert await usage.flush_if_due() is True
    assert "s1" in store.sessions


async def test_switching_character_logs_and_splits_usage() -> None:
    usage, store, clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    clock.advance(5.0)
    usage.record_turn("s1", "snow", voice=False)

    assert await usage.flush() is True

    assert store.switches == [(1005.0, "amber", "snow")]
    assert store.char_seconds == {"amber": 5.0, "snow": 0.0}
    assert store.char_sessions == {"amber": 1, "snow": 1}
    assert store.sessions["s1"].char_id == "snow"


async def test_disabled_recording_drops_everything() -> None:
    usage, store, _clock = _service()
    assert await usage.set_enabled(False) is True

    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is False
    assert store.sessions == {}
    assert store.meta[META_RECORDING_ENABLED] == "0"
    assert usage.enabled is False


async def test_enabled_flag_is_loaded_from_meta() -> None:
    store = FakeStore(meta={META_RECORDING_ENABLED: "0"})
    usage, _store, _clock = _service(store)
    usage.record_turn("s1", "amber", voice=False)  # 先读 meta，发现被暂停
    assert await usage.flush() is False

    assert await usage.set_enabled(True) is True
    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is True


async def test_meta_unreadable_defaults_to_recording() -> None:
    store = FakeStore(fail_on={"read_meta"})
    usage, _store, _clock = _service(store)

    assert usage.enabled is True
    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is True


async def test_write_failure_is_swallowed() -> None:
    """§6.7 A 级：统计写失败只记日志，绝不让对话崩掉。"""
    store = FakeStore(fail_on={"write_session"})
    usage, _store, _clock = _service(store)
    usage.record_turn("s1", "amber", voice=False)

    assert await usage.flush() is False
    assert store.sessions == {}


async def test_clear_drops_sessions_and_store_rows() -> None:
    usage, store, _clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is True

    assert await usage.clear() is True
    assert store.cleared == 1
    assert usage.open_session_count == 0


async def test_stop_flushes_open_sessions_and_closes_store() -> None:
    usage, store, clock = _service()
    usage.record_turn("s1", "amber", voice=False)
    clock.advance(7.0)

    await usage.stop()

    assert store.sessions["s1"].ended_at == clock.t
    assert usage.open_session_count == 0
    assert store.closed is True


async def test_recording_a_closed_session_starts_a_new_burst() -> None:
    usage, store, clock = _service(idle_timeout_s=10.0)
    usage.record_turn("s1", "amber", voice=False)
    clock.advance(11.0)
    assert await usage.flush() is True

    usage.record_turn("s1", "amber", voice=False)
    assert usage.open_session_count == 1
    clock.advance(1.0)
    assert await usage.flush() is True
    assert store.sessions["s1"].started_at == 1011.0


async def test_real_sqlite_round_trip(tmp_path: Path) -> None:
    """端到端：真 SQLite + 默认装配，确认会话/角色/每日三张表都落到了行。"""
    usage = build_usage_service(Settings(data_dir=tmp_path))
    usage.record_turn("s1", "amber", voice=True)
    assert await usage.flush() is True
    await usage.stop()

    db = tmp_path / "usage.db"
    conn = sqlite3.connect(db)
    try:
        sessions = list(conn.execute("SELECT id, char_id, msg_count, voice_msg_count FROM session"))
        chars = list(conn.execute("SELECT char_id, session_count FROM char_usage"))
        daily = list(conn.execute("SELECT date, session_count, msg_count FROM daily"))
    finally:
        conn.close()

    assert sessions == [("s1", "amber", 1, 1)]
    assert chars == [("amber", 1)]
    assert daily[0][1:] == (1, 1)


def test_create_app_exposes_usage_service(tmp_path: Path) -> None:
    from app import create_app

    app = create_app(settings=Settings(data_dir=tmp_path))
    usage = app.state.usage_service

    assert isinstance(usage, UsageService)
    assert not (tmp_path / "usage.db").exists()  # 建 app 不建库
    assert usage.enabled is True
    assert (tmp_path / "usage.db").exists()  # 第一次读开关才建库


async def test_new_session_carries_configured_providers() -> None:
    """T1.14：会话一建立就把当时的三套供给写进行里（之后切端点也不改历史）。"""
    usage, store, _clock = _service(providers=ProviderNames(llm="cloud", asr="local", tts="local"))
    usage.record_turn("s1", "amber", voice=False)
    assert await usage.flush() is True

    row = store.sessions["s1"]
    assert (row.llm_provider, row.asr_provider, row.tts_provider) == ("cloud", "local", "local")


async def test_record_provider_overrides_llm_and_is_flushed() -> None:
    """主用失败切到备用之后：把真正聊上的那套供给盖上去，并在下次 flush 落盘。"""
    usage, store, _clock = _service(providers=ProviderNames(llm="cloud", asr="local", tts="local"))
    usage.record_turn("s1", "amber", voice=False)
    usage.record_provider("s1", "fallback")
    assert await usage.flush() is True

    assert store.sessions["s1"].llm_provider == "fallback"


async def test_record_provider_without_session_is_ignored() -> None:
    """没记过会话就没有账本行可改：静默忽略，绝不建一条假会话。"""
    usage, store, _clock = _service()
    usage.record_provider("__none__", "fallback")
    assert await usage.flush() is False
    assert store.sessions == {}


# ---------------------------------------------------------------- 窗口晃动（T2.3-C1）


async def test_window_shake_lands_on_the_open_chat_session() -> None:
    """正在聊的会话优先承接晃动：边聊边晃算同一段使用，不另开账本。"""
    usage, store, _clock = _service()
    usage.record_turn("s1", "amber", voice=False)

    assert usage.record_window_shake("amber") is True
    assert await usage.flush() is True

    assert store.sessions["s1"].window_shake_count == 1
    assert "ui:amber" not in store.sessions


async def test_window_shake_without_chat_opens_ui_session_without_counting() -> None:
    """还没聊过也能乱晃：开一条 ui: 会话记账，但不算「开了一场对话」。"""
    usage, store, _clock = _service()

    assert usage.record_window_shake("amber") is True
    assert await usage.flush() is True

    assert store.sessions["ui:amber"].window_shake_count == 1
    assert store.char_sessions == {}, "纯 UI 操作不增加角色会话次数"
    assert store.daily == {}, "也不进每日统计"


async def test_window_shake_without_character_is_ignored() -> None:
    """带不上角色就不知道记给谁：直接拒绝，别造一条匿名行。"""
    usage, store, _clock = _service()

    assert usage.record_window_shake("") is False
    assert await usage.flush() is False
    assert store.sessions == {}


async def test_window_shake_respects_recording_switch() -> None:
    """暂停记录时连 UI 事实也不记：暂停就是暂停。"""
    usage, store, _clock = _service()
    await usage.set_enabled(False)

    assert usage.record_window_shake("amber") is False
    assert store.sessions == {}
