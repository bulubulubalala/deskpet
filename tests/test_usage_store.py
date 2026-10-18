"""文件职责：单测 adapters/usage_sqlite.py——建表、UPSERT 累加、清空与惰性连接（§6.9）。

依赖方向：tests -> adapters / core；用 tmp_path 真建一个 SQLite 文件，不碰仓库 data/。
谁调用：pytest。
"""

from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

from adapters.usage_sqlite import UsageSqliteStore
from core.usage import META_SCHEME_VERSION, SCHEME_VERSION, SessionRow


def _store(tmp_path: Path) -> UsageSqliteStore:
    return UsageSqliteStore(tmp_path / "usage.db")


def _row(**overrides: object) -> SessionRow:
    base = SessionRow(
        session_id="s1",
        char_id="amber",
        started_at=100.0,
        ended_at=None,
        duration_sec=5.0,
        msg_count=1,
        interrupt_count=0,
        voice_msg_count=0,
        text_msg_count=1,
        screen_capture_count=0,
        window_shake_count=0,
    )
    return replace(base, **overrides)  # type: ignore[arg-type]


def _query(path: Path, sql: str) -> list[tuple[object, ...]]:
    conn = sqlite3.connect(path)
    try:
        return list(conn.execute(sql))
    finally:
        conn.close()


def test_construct_does_not_touch_disk(tmp_path: Path) -> None:
    """只构造不读写：应用启动不该因为统计模块凭空造出一个 usage.db。"""
    store = _store(tmp_path)

    assert store.path == tmp_path / "usage.db"
    assert not (tmp_path / "usage.db").exists()

    store.close()  # 从未连接过，close 也必须安全


def test_schema_and_meta(tmp_path: Path) -> None:
    store = _store(tmp_path)

    assert store.read_meta(META_SCHEME_VERSION) == SCHEME_VERSION
    assert store.read_meta("recording_enabled") is None

    store.write_meta("recording_enabled", "0")
    assert store.read_meta("recording_enabled") == "0"
    store.close()


def test_write_session_upserts_in_place(tmp_path: Path) -> None:
    """同一个会话反复 flush 只能有一行（绝对值覆盖，天然幂等）。"""
    store = _store(tmp_path)
    store.write_session(_row())
    store.write_session(
        _row(
            ended_at=200.0,
            duration_sec=9.5,
            msg_count=3,
            interrupt_count=1,
            voice_msg_count=2,
            text_msg_count=1,
            screen_capture_count=1,
        )
    )
    store.close()

    rows = _query(
        tmp_path / "usage.db",
        "SELECT id, char_id, ended_at, duration_sec, msg_count, interrupt_count,"
        " voice_msg_count, text_msg_count, screen_capture_count FROM session",
    )
    assert rows == [("s1", "amber", 200.0, 9.5, 3, 1, 2, 1, 1)]


def test_char_usage_accumulates_and_keeps_first_used(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.add_char_usage("amber", seconds=10.0, sessions=1, at=100.0)
    store.add_char_usage("amber", seconds=5.5, sessions=1, at=200.0)
    store.close()

    rows = _query(
        tmp_path / "usage.db",
        "SELECT char_id, first_used_at, last_used_at, total_duration_sec, session_count"
        " FROM char_usage",
    )
    assert rows == [("amber", 100.0, 200.0, 15.5, 2)]


def test_daily_accumulates_and_switch_log_appends(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.add_daily("2026-10-15", duration_sec=30.0, session_count=1, msg_count=4)
    store.add_daily("2026-10-15", duration_sec=10.0, session_count=1, msg_count=2)
    store.append_switch(150.0, "amber", "snow")
    store.append_switch(250.0, "snow", "amber")
    store.close()

    assert _query(
        tmp_path / "usage.db", "SELECT date, duration_sec, session_count, msg_count FROM daily"
    ) == [("2026-10-15", 40.0, 2, 6)]
    switches = _query(
        tmp_path / "usage.db", "SELECT at, from_char_id, to_char_id FROM switch_log ORDER BY id"
    )
    assert switches == [(150.0, "amber", "snow"), (250.0, "snow", "amber")]


def test_clear_usage_keeps_meta(tmp_path: Path) -> None:
    """「清空统计」只清统计，记录开关与表结构版本得留着。"""
    store = _store(tmp_path)
    store.write_session(_row())
    store.add_char_usage("amber", seconds=1.0, sessions=1, at=100.0)
    store.add_daily("2026-10-15", duration_sec=1.0, session_count=1, msg_count=1)
    store.append_switch(100.0, None, "amber")
    store.write_meta("recording_enabled", "1")

    store.clear_usage()
    store.close()

    assert _query(tmp_path / "usage.db", "SELECT COUNT(*) FROM session") == [(0,)]
    assert _query(tmp_path / "usage.db", "SELECT COUNT(*) FROM char_usage") == [(0,)]
    assert _query(tmp_path / "usage.db", "SELECT COUNT(*) FROM daily") == [(0,)]
    assert _query(tmp_path / "usage.db", "SELECT COUNT(*) FROM switch_log") == [(0,)]
    assert _query(
        tmp_path / "usage.db", "SELECT value FROM meta WHERE key = 'recording_enabled'"
    ) == [("1",)]


def test_close_is_idempotent(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.read_meta(META_SCHEME_VERSION)
    store.close()
    store.close()

    assert (tmp_path / "usage.db").exists()


def test_provider_columns_are_persisted(tmp_path: Path) -> None:
    """T1.14：session 行必须记下这一轮用的三套供给（§6.13）——使用历史无法回填。"""
    store = _store(tmp_path)
    store.write_session(_row(llm_provider="local", asr_provider="local", tts_provider="cloud"))
    store.close()

    conn = sqlite3.connect(tmp_path / "usage.db")
    try:
        rows = conn.execute(
            "SELECT llm_provider, asr_provider, tts_provider FROM session"
        ).fetchall()
    finally:
        conn.close()
    assert rows == [("local", "local", "cloud")]


def test_window_shake_count_is_persisted(tmp_path: Path) -> None:
    """T2.3-C1：窗口晃动是 session 上的计数列，写一次就得能读回来。"""
    store = _store(tmp_path)
    store.write_session(_row(window_shake_count=3))
    store.close()

    assert _query(tmp_path / "usage.db", "SELECT window_shake_count FROM session") == [(3,)]


def test_old_schema_database_gets_provider_columns(tmp_path: Path) -> None:
    """T1.14 之前建的 usage.db 缺三列（T2.3 的晃动列也缺）：补空列，不整层报错丢数据。"""
    path = tmp_path / "usage.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE session ("
        " id TEXT PRIMARY KEY,"
        " char_id TEXT NOT NULL,"
        " started_at REAL NOT NULL,"
        " ended_at REAL,"
        " duration_sec REAL NOT NULL DEFAULT 0,"
        " msg_count INTEGER NOT NULL DEFAULT 0,"
        " interrupt_count INTEGER NOT NULL DEFAULT 0,"
        " voice_msg_count INTEGER NOT NULL DEFAULT 0,"
        " text_msg_count INTEGER NOT NULL DEFAULT 0,"
        " screen_capture_count INTEGER NOT NULL DEFAULT 0);"
    )
    conn.commit()
    conn.close()

    store = _store(tmp_path)
    store.write_session(_row(llm_provider="cloud", window_shake_count=1))
    store.close()

    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(
            "SELECT llm_provider, asr_provider, tts_provider, window_shake_count FROM session"
        ).fetchall()
    finally:
        conn.close()
    assert rows == [("cloud", "", "", 1)]
