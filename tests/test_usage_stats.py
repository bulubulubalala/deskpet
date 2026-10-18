"""文件职责：usage 统计只读汇总（adapters/usage_sqlite.py 的 UsageStatsReader）测试。

依赖方向：tests -> adapters.usage_sqlite / core.usage；库建在 tmp_path 下。
测试重点：库不存在时返回空统计且不落盘、按角色聚合打断与消息数、
全局会话数与角色时长排名、时段样本条数上限。
谁调用：pytest。
"""

import sqlite3
import time
from pathlib import Path

from adapters.usage_sqlite import UsageSqliteStore, UsageStatsReader
from core.usage import SessionRow

CHAR = "amber"
OTHER = "nova"
BASE_TS = 1_700_000_000.0


def _session(
    session_id: str,
    char_id: str,
    *,
    started_at: float = BASE_TS,
    duration_sec: float = 60.0,
    msg_count: int = 1,
    interrupt_count: int = 0,
    window_shake_count: int = 0,
) -> SessionRow:
    return SessionRow(
        session_id=session_id,
        char_id=char_id,
        started_at=started_at,
        ended_at=started_at + duration_sec,
        duration_sec=duration_sec,
        msg_count=msg_count,
        interrupt_count=interrupt_count,
        voice_msg_count=0,
        text_msg_count=msg_count,
        screen_capture_count=0,
        window_shake_count=window_shake_count,
    )


def _store(tmp_path: Path) -> UsageSqliteStore:
    return UsageSqliteStore(tmp_path / "usage.db")


def test_missing_database_returns_empty_stats(tmp_path: Path) -> None:
    """一次对话都没发生过时不能凭空造出 usage.db，也不该抛异常。"""
    path = tmp_path / "usage.db"
    stats = UsageStatsReader(path).behavior_stats(CHAR)

    assert stats.char_id == CHAR
    assert stats.char_sessions == 0
    assert stats.char_interrupts == 0
    assert stats.char_messages == 0
    assert stats.total_sessions == 0
    assert stats.start_hours == ()
    assert stats.characters == ()
    assert not path.exists()


def test_aggregates_counts_and_characters(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR, interrupt_count=1, msg_count=3))
    store.write_session(_session("s2", CHAR, interrupt_count=2, msg_count=4))
    store.write_session(_session("s3", OTHER, interrupt_count=9, msg_count=9))
    store.add_char_usage(CHAR, seconds=300.0, sessions=2, at=BASE_TS)
    store.add_char_usage(OTHER, seconds=60.0, sessions=1, at=BASE_TS)
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(CHAR)

    assert stats.char_sessions == 2, "只算这个角色自己的会话"
    assert stats.char_interrupts == 3
    assert stats.char_messages == 7
    assert stats.total_sessions == 3, "角色偏好要看全局会话数"
    assert len(stats.start_hours) == 3
    assert [item.char_id for item in stats.characters] == [CHAR, OTHER], "按累计时长降序"
    assert stats.characters[0].total_duration_sec == 300.0
    assert stats.characters[0].session_count == 2


def test_unknown_character_keeps_global_count(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR))
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(OTHER)

    assert stats.char_sessions == 0
    assert stats.total_sessions == 1


def test_hour_samples_are_capped(tmp_path: Path) -> None:
    """时段观察最多回看固定条数：库很大时也不能把整张 session 表读进内存。"""
    store = _store(tmp_path)
    for index in range(5):
        store.write_session(_session("s" + str(index), CHAR, started_at=BASE_TS + index))
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db", hour_samples=2).behavior_stats(CHAR)

    assert len(stats.start_hours) == 2
    assert stats.start_hours == tuple(
        time.localtime(BASE_TS + index).tm_hour for index in (4, 3)
    ), "取最近开始的两次会话"


def test_hour_samples_floor_is_one(tmp_path: Path) -> None:
    """hour_samples=0 会让 SQL 的 LIMIT 变成 0，实现必须兜到 1。"""
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR))
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db", hour_samples=0).behavior_stats(CHAR)
    assert len(stats.start_hours) == 1


def test_sqlite_store_usage_does_not_share_connection(tmp_path: Path) -> None:
    """写连接还开着时读汇总也必须能拿到数据（WAL + 临时读连接）。"""
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR, interrupt_count=2))

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(CHAR)
    assert stats.char_interrupts == 2, "读侧不该等写侧 close"
    store.close()


def test_behavior_stats_sums_window_shakes(tmp_path: Path) -> None:
    """T2.3-C1：晃动按角色累加，供行为记忆推导「他爱晃你」的档位。"""
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR, window_shake_count=2))
    store.write_session(_session("s2", CHAR, window_shake_count=3))
    store.write_session(_session("s3", OTHER, window_shake_count=9))
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(CHAR)

    assert stats.char_shakes == 5
    assert stats.char_sessions == 2


def test_behavior_stats_counts_char_hits(tmp_path: Path) -> None:
    """T2.3-C2c：触摸按角色累加会话数、部位数与手势分布，供行为观察分档。"""
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR))
    store.write_char_hit(CHAR, "head", gesture="tap", count=3, max_streak=3, at=BASE_TS)
    store.write_char_hit(CHAR, "tail", gesture="tap", count=2, max_streak=1, at=BASE_TS)
    store.write_char_hit(CHAR, "head", gesture="pat", count=1, max_streak=1, at=BASE_TS)
    store.write_char_hit(OTHER, "head", gesture="tap", count=9, max_streak=9, at=BASE_TS)
    store.close()

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(CHAR)

    assert stats.char_hits == 6, "只算这个角色的触摸会话数"
    assert stats.hit_regions == 2, "不同部位数按行数算"
    assert stats.gesture_counts == (("tap", 5), ("pat", 1)), "手势按次数从多到少"


def test_behavior_stats_tolerates_missing_char_hits_table(tmp_path: Path) -> None:
    """T2.3-C2 之前建的库没有 char_hits 表：当作没点过，不整层报错。"""
    store = _store(tmp_path)
    store.write_session(_session("s1", CHAR))
    store.close()
    with sqlite3.connect(tmp_path / "usage.db") as conn:
        conn.execute("DROP TABLE char_hits")

    stats = UsageStatsReader(tmp_path / "usage.db").behavior_stats(CHAR)

    assert stats.char_hits == 0
    assert stats.hit_regions == 0
    assert stats.char_sessions == 1
