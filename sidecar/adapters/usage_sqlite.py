"""文件职责：usage.db 的 SQLite 实现（建表 + 增量写入），实现 core.usage.UsageStore。

依赖方向：adapters 只实现 core 定义的 Protocol（CODE_STYLE §1.1），不 import services / api。
谁调用：services/usage_service.py 的 build_usage_service(settings)。

三条设计要点：
- **惰性连接**：构造时完全不碰磁盘，第一次读写才建库建表。统计模块坏了不该拖累启动，
  更不该在只跑一次 /health 的冒烟里凭空造出一个 usage.db。
- **只追加不覆盖历史**：唯一会删数据的入口是 clear_usage()（用户主动「清空统计」）；
  char_usage / daily 用 UPSERT 累加，session 整行覆盖（绝对值，天然幂等）。
- **加密留缝**：M1 先用标准库 sqlite3；M2 起按 §6.5 换 SQLCipher 整库加密，
  届时只需替换 _connect() 里的连接构造与 PRAGMA key。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from core.usage import (
    META_SCHEME_VERSION,
    SCHEME_VERSION,
    BehaviorStats,
    CharacterUsage,
    SessionRow,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    char_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    ended_at REAL,
    duration_sec REAL NOT NULL DEFAULT 0,
    msg_count INTEGER NOT NULL DEFAULT 0,
    interrupt_count INTEGER NOT NULL DEFAULT 0,
    voice_msg_count INTEGER NOT NULL DEFAULT 0,
    text_msg_count INTEGER NOT NULL DEFAULT 0,
    screen_capture_count INTEGER NOT NULL DEFAULT 0,
    window_shake_count INTEGER NOT NULL DEFAULT 0,
    llm_provider TEXT NOT NULL DEFAULT '',
    asr_provider TEXT NOT NULL DEFAULT '',
    tts_provider TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS char_usage (
    char_id TEXT PRIMARY KEY,
    first_used_at REAL NOT NULL,
    last_used_at REAL NOT NULL,
    total_duration_sec REAL NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS switch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at REAL NOT NULL,
    from_char_id TEXT,
    to_char_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily (
    date TEXT PRIMARY KEY,
    duration_sec REAL NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    msg_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS char_hits (
    char_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    gesture TEXT NOT NULL DEFAULT 'tap',
    count INTEGER NOT NULL DEFAULT 0,
    max_streak INTEGER NOT NULL DEFAULT 0,
    last_at REAL NOT NULL,
    PRIMARY KEY (char_id, region_id, gesture)
);
"""

_UPSERT_SESSION = """
INSERT INTO session (
    id, char_id, started_at, ended_at, duration_sec,
    msg_count, interrupt_count, voice_msg_count, text_msg_count, screen_capture_count,
    window_shake_count, llm_provider, asr_provider, tts_provider
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    char_id = excluded.char_id,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    duration_sec = excluded.duration_sec,
    msg_count = excluded.msg_count,
    interrupt_count = excluded.interrupt_count,
    voice_msg_count = excluded.voice_msg_count,
    text_msg_count = excluded.text_msg_count,
    screen_capture_count = excluded.screen_capture_count,
    window_shake_count = excluded.window_shake_count,
    llm_provider = excluded.llm_provider,
    asr_provider = excluded.asr_provider,
    tts_provider = excluded.tts_provider
"""

#: 后续版本给 session 新增的列：老库没有就补上（CREATE TABLE IF NOT EXISTS 不补列）。
#: v2（T1.14）三列供给名；v3（T2.3）一列窗口晃动计数。
_SESSION_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("llm_provider", "TEXT NOT NULL DEFAULT ''"),
    ("asr_provider", "TEXT NOT NULL DEFAULT ''"),
    ("tts_provider", "TEXT NOT NULL DEFAULT ''"),
    ("window_shake_count", "INTEGER NOT NULL DEFAULT 0"),
)

#: 时段观察最多回看多少次会话开始时间（够用来判断「他常几点来」）
MAX_HOUR_SAMPLES = 200


def _ensure_session_columns(conn: sqlite3.Connection) -> None:
    """给旧库补上后续版本新增的 session 列（幂等）。

    统计历史无法回填，但也不能因为缺列就让整个记录层报错——按列类型补默认值，
    语义是「这一项当时没记」。
    """
    existing = {str(row[1]) for row in conn.execute("PRAGMA table_info(session)")}
    for column, definition in _SESSION_ADDED_COLUMNS:
        if column not in existing:
            conn.execute("ALTER TABLE session ADD COLUMN " + column + " " + definition)


_UPSERT_CHAR_USAGE = """
INSERT INTO char_usage (char_id, first_used_at, last_used_at, total_duration_sec, session_count)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(char_id) DO UPDATE SET
    last_used_at = MAX(char_usage.last_used_at, excluded.last_used_at),
    total_duration_sec = char_usage.total_duration_sec + excluded.total_duration_sec,
    session_count = char_usage.session_count + excluded.session_count
"""

_UPSERT_DAILY = """
INSERT INTO daily (date, duration_sec, session_count, msg_count)
VALUES (?, ?, ?, ?)
ON CONFLICT(date) DO UPDATE SET
    duration_sec = daily.duration_sec + excluded.duration_sec,
    session_count = daily.session_count + excluded.session_count,
    msg_count = daily.msg_count + excluded.msg_count
"""


#: 触摸按 (角色, 部位, 手势) 聚合：count 累加、max_streak 取历史最大、last_at 取最新（T2.3-C2c）
#: count 数的是「触摸会话」；tap/pat 一次会话算 1 次，另存最大连击数供行为观察用
_UPSERT_CHAR_HIT = """
INSERT INTO char_hits (char_id, region_id, gesture, count, max_streak, last_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(char_id, region_id, gesture) DO UPDATE SET
    count = char_hits.count + excluded.count,
    max_streak = MAX(char_hits.max_streak, excluded.max_streak),
    last_at = MAX(char_hits.last_at, excluded.last_at)
"""


def _ensure_char_hits_columns(conn: sqlite3.Connection) -> None:
    """老库的 char_hits 没有 gesture 列（T2.3-C2c 之前建的）：这张表只是统计，直接重建。

    重建会丢掉旧的部位计数——可接受：手势分档变了以后旧数据归不到任何一个手势上，
    留着反而会污染行为观察。
    """
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(char_hits)").fetchall()}
    if columns and "gesture" not in columns:
        conn.execute("DROP TABLE char_hits")
        conn.executescript(_SCHEMA)


class UsageSqliteStore:
    """usage.db 的落地实现；所有方法都是同步的，由上层放进线程池调用。"""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: sqlite3.Connection | None = None

    @property
    def path(self) -> Path:
        """库文件路径（日志与排障用；此时未打开也算数）。"""
        return self._path

    def _connection(self) -> sqlite3.Connection:
        """打开（或复用）连接，并保证表结构存在。"""
        if self._conn is not None:
            return self._conn
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False：第一次读 meta 发生在事件循环线程（record_turn 是同步接口），
        # 之后整批写盘走 asyncio.to_thread 的工作线程。UsageService 用单把 asyncio.Lock
        # 串行化所有落盘调用，连接不会被两个线程同时使用。
        conn = sqlite3.connect(self._path, check_same_thread=False)
        # WAL：flush 是突发写，读侧（统计页/装配器）不该被写锁挡住；NORMAL 对统计足够。
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(_SCHEMA)
        _ensure_session_columns(conn)
        _ensure_char_hits_columns(conn)
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            (META_SCHEME_VERSION, SCHEME_VERSION),
        )
        conn.commit()
        self._conn = conn
        return conn

    def read_meta(self, key: str) -> str | None:
        row = self._connection().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return str(row[0])

    def write_meta(self, key: str, value: str) -> None:
        conn = self._connection()
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

    def write_session(self, row: SessionRow) -> None:
        conn = self._connection()
        conn.execute(
            _UPSERT_SESSION,
            (
                row.session_id,
                row.char_id,
                row.started_at,
                row.ended_at,
                row.duration_sec,
                row.msg_count,
                row.interrupt_count,
                row.voice_msg_count,
                row.text_msg_count,
                row.screen_capture_count,
                row.window_shake_count,
                row.llm_provider,
                row.asr_provider,
                row.tts_provider,
            ),
        )
        conn.commit()

    def add_char_usage(self, char_id: str, *, seconds: float, sessions: int, at: float) -> None:
        conn = self._connection()
        conn.execute(_UPSERT_CHAR_USAGE, (char_id, at, at, seconds, sessions))
        conn.commit()

    def add_daily(
        self, date: str, *, duration_sec: float, session_count: int, msg_count: int
    ) -> None:
        conn = self._connection()
        conn.execute(_UPSERT_DAILY, (date, duration_sec, session_count, msg_count))
        conn.commit()

    def write_char_hit(
        self,
        char_id: str,
        region_id: str,
        *,
        gesture: str,
        count: int,
        max_streak: int,
        at: float,
    ) -> None:
        """并进 char_hits（T2.3-C2c 的触摸；count 是自上次落盘以来的触摸会话数增量）。"""
        conn = self._connection()
        conn.execute(_UPSERT_CHAR_HIT, (char_id, region_id, gesture, count, max_streak, at))
        conn.commit()

    def append_switch(self, at: float, from_char_id: str | None, to_char_id: str) -> None:
        conn = self._connection()
        conn.execute(
            "INSERT INTO switch_log (at, from_char_id, to_char_id) VALUES (?, ?, ?)",
            (at, from_char_id, to_char_id),
        )
        conn.commit()

    def clear_usage(self) -> None:
        """清空统计；**保留 meta**（记录开关与表结构版本不是统计内容）。"""
        conn = self._connection()
        conn.execute("DELETE FROM session")
        conn.execute("DELETE FROM char_usage")
        conn.execute("DELETE FROM switch_log")
        conn.execute("DELETE FROM daily")
        conn.execute("DELETE FROM char_hits")
        conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


class UsageStatsReader:
    """行为观察的**只读**汇总（T2.1c）：每次调用现开一条连接，用完即关。

    为什么不复用 UsageSqliteStore 的写连接：写盘在 asyncio.to_thread 的工作线程里跑，
    行为观察的刷新也在线程池里跑，两条线程共用一个 sqlite3 连接并不安全；
    而 WAL 下「一个写连接 + 若干临时读连接」本来就是标准用法，读不挡写。

    库还不存在（一次对话都没发生过）时返回空统计，而不是凭空造出一个 usage.db。
    """

    def __init__(self, path: Path, *, hour_samples: int = MAX_HOUR_SAMPLES) -> None:
        self._path = path
        self._hour_samples = hour_samples

    @property
    def path(self) -> Path:
        """库文件路径（日志与排障用）。"""
        return self._path

    def behavior_stats(self, char_id: str) -> BehaviorStats:
        """汇总打断 / 时段 / 角色偏好需要的计数；库不存在时每一项都是 0。"""
        if not self._path.exists():
            return BehaviorStats(char_id=char_id)
        with sqlite3.connect(self._path) as conn:
            counts = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(interrupt_count), 0), "
                "COALESCE(SUM(msg_count), 0), COALESCE(SUM(window_shake_count), 0) "
                "FROM session WHERE char_id = ?",
                (char_id,),
            ).fetchone()
            try:
                hits = conn.execute(
                    "SELECT COALESCE(SUM(count), 0), COUNT(DISTINCT region_id) "
                    "FROM char_hits WHERE char_id = ?",
                    (char_id,),
                ).fetchone()
                gesture_rows = conn.execute(
                    "SELECT gesture, COALESCE(SUM(count), 0) FROM char_hits WHERE char_id = ? "
                    "GROUP BY gesture ORDER BY 2 DESC, 1 ASC",
                    (char_id,),
                ).fetchall()
            except sqlite3.OperationalError:
                # 老库还没有 char_hits 表（T2.3-C2 之前建的）：当作没点过，不阻断统计
                hits = (0, 0)
                gesture_rows = []
            total_row = conn.execute("SELECT COUNT(*) FROM session").fetchone()
            starts = conn.execute(
                "SELECT started_at FROM session ORDER BY started_at DESC LIMIT ?",
                (max(1, self._hour_samples),),
            ).fetchall()
            characters = conn.execute(
                "SELECT char_id, total_duration_sec, session_count FROM char_usage "
                "ORDER BY total_duration_sec DESC, char_id ASC"
            ).fetchall()
        sessions, interrupts, messages, shakes = (
            int(value or 0) for value in (counts or (0, 0, 0, 0))
        )
        hit_count, hit_regions = (int(value or 0) for value in (hits or (0, 0)))
        return BehaviorStats(
            char_id=char_id,
            char_sessions=sessions,
            char_interrupts=interrupts,
            char_messages=messages,
            char_shakes=shakes,
            char_hits=hit_count,
            hit_regions=hit_regions,
            gesture_counts=tuple(
                (str(row[0]), int(row[1] or 0)) for row in gesture_rows if str(row[0])
            ),
            total_sessions=int((total_row or (0,))[0] or 0),
            start_hours=tuple(
                time.localtime(float(row[0])).tm_hour for row in starts if row[0] is not None
            ),
            characters=tuple(
                CharacterUsage(
                    char_id=str(row[0]),
                    total_duration_sec=float(row[1] or 0.0),
                    session_count=int(row[2] or 0),
                )
                for row in characters
            ),
        )
