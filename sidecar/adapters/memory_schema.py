"""文件职责：记忆库的建表 / 迁移 / 迁移自检（D3），从 memory_sqlite 拆出来。

依赖方向：adapters -> core；只用 sqlite3/sqlcipher 的连接与 core.memory 的异常类型。
谁调用：MemorySqliteStore.__init__ 里构造一次，随后 ensure()。
为什么单独成文件：建表语句 + 迁移脚本属于「库结构」，和「怎么查怎么写」是两条独立的变化线——
改结构时不必在两千行的存储实现里翻找，迁移逻辑也能用假连接单测。
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.logging import get_logger, log_event
from core.memory import MemoryBackendError, to_fts_body

LOGGER = get_logger("adapters.memory_schema")

#: 库结构版本（PRAGMA user_version）：以后加表 / 加列就 +1，并在 _ensure_schema 里写迁移。
SCHEMA_VERSION = 8
#: 迁移前留底放在库文件同级的 backups/ 下（与每日快照同一目录，用户找得到）
BACKUP_DIR_NAME = "backups"
#: 同一个旧版本只留最近几份迁移前备份（迁移很少发生，留太多只会占空间）
PRE_MIGRATION_KEEP = 3
#: 迁移前后要逐表对数的表（FTS 影子表不算，它们由 integrity-check 验）
COUNTED_TABLES = (
    "messages",
    "memories",
    "summaries",
    "memory_periods",
    "memory_period_sources",
    "diary_entries",
    "memory_intentions",
    "memory_entities",
    "memory_links",
    "memory_relations",
)
#: 迁移后要跑 integrity-check 的 FTS5 表
FTS_TABLES = ("messages_fts", "memories_fts", "memory_periods_fts")

LOGGER = get_logger("adapters.memory_sqlite")

ConnectionFactory = Callable[[str], Any]
Clock = Callable[[], float]

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts REAL NOT NULL,
    token_len INTEGER NOT NULL DEFAULT 0,
    covered_by INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_char_ts ON messages(char_id, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'fact',
    text TEXT NOT NULL,
    text_key TEXT NOT NULL,
    importance REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    source_msg_ids TEXT NOT NULL DEFAULT '',
    occurred_at REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.7,
    strength REAL NOT NULL DEFAULT 0.5,
    state TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_used_at REAL,
    used_count INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedup ON memories(char_id, text_key);
CREATE INDEX IF NOT EXISTS idx_memories_char_created ON memories(char_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(body, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    char_id TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dim INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    source_ts REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_source_model
    ON memory_embeddings(source_type, source_id, model_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_char_model
    ON memory_embeddings(char_id, source_type, model_id);

CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    text TEXT NOT NULL,
    covers_from REAL NOT NULL,
    covers_to REAL NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    archived_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_summaries_char_tier ON summaries(char_id, tier, created_at);

-- 时间金字塔（T2.33）：Episode / Day / Week / Month。旧 summaries 保留为 legacy 回退。
CREATE TABLE IF NOT EXISTS memory_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    level TEXT NOT NULL,
    period_start REAL NOT NULL,
    period_end REAL NOT NULL,
    day_key TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    source_hash TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    edited_at REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    archived_at REAL NOT NULL DEFAULT 0,
    strength REAL NOT NULL DEFAULT 0.5,
    state TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_periods_unique
    ON memory_periods(char_id, level, period_start);
CREATE INDEX IF NOT EXISTS idx_periods_char_level_start
    ON memory_periods(char_id, level, period_start DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_periods_fts USING fts5(body, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS memory_period_sources (
    period_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    PRIMARY KEY(period_id, source_type, source_id),
    FOREIGN KEY(period_id) REFERENCES memory_periods(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_period_sources_target
    ON memory_period_sources(source_type, source_id);

CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    text TEXT NOT NULL,
    occurred_at REAL NOT NULL,
    mood TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_char_occurred
    ON diary_entries(char_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS memory_intentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    text TEXT NOT NULL,
    trigger_at REAL NOT NULL DEFAULT 0,
    trigger_context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at REAL NOT NULL,
    resolved_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_intentions_char_status
    ON memory_intentions(char_id, status, trigger_at);

CREATE TABLE IF NOT EXISTS memory_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'topic',
    aliases TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unique ON memory_entities(char_id, name);

CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    from_type TEXT NOT NULL,
    from_id INTEGER NOT NULL,
    to_type TEXT NOT NULL,
    to_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    confidence REAL NOT NULL DEFAULT 0.7,
    created_at REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique
    ON memory_links(char_id, from_type, from_id, to_type, to_id, relation);
CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(char_id, from_type, from_id);

CREATE TABLE IF NOT EXISTS memory_relations (
    char_id TEXT PRIMARY KEY,
    familiarity REAL NOT NULL DEFAULT 0.5,
    trust REAL NOT NULL DEFAULT 0.5,
    warmth REAL NOT NULL DEFAULT 0.5,
    unresolved TEXT NOT NULL DEFAULT '',
    recent_conflict TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL DEFAULT 0
);

-- state 表留给 T2.4 / T2.6（关系、心情、上次说话时间、主动问候的忽略次数）；
-- T2.1 只建表，不提供读写方法，避免出现没人调用的接口。
CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL UNIQUE,
    relation_json TEXT NOT NULL DEFAULT '',
    mood_json TEXT NOT NULL DEFAULT '',
    last_seen_ts REAL NOT NULL DEFAULT 0,
    last_proactive_ts REAL NOT NULL DEFAULT 0,
    proactive_ignored_streak INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
"""


class MemorySchema:
    """一条连接上的建表与迁移；构造后调用一次 ensure()。"""

    def __init__(
        self,
        connection: Any,
        path: Path,
        *,
        clock: Callable[[], float] = time.time,
        translate: Callable[[sqlite3.Error], MemoryBackendError],
        lock: Any | None = None,
    ) -> None:
        self._connection = connection
        self._path = path
        self._clock = clock
        self._translate = translate
        # 与 store 共用同一把可重入锁：建表/迁移和读写必须互斥
        self._lock = lock if lock is not None else threading.RLock()

    def ensure(self) -> None:
        with self._lock:
            version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise MemoryBackendError(
                    f"记忆库版本 {version} 高于本程序支持的 {SCHEMA_VERSION}，请更新 deskpet"
                )
            if version == SCHEMA_VERSION:
                return
            # D3：迁移前先留底并记账，迁移后逐表对数 + FTS 自检。新建库（version=0 且没表）
            # 不需要留底——它没有可丢的数据。
            fresh = version == 0 and not self._has_tables()
            before = {} if fresh else self._table_counts()
            guard = None if fresh else self._pre_migration_backup(version)
            try:
                self._connection.executescript(SCHEMA_SQL)
                summary_columns = {
                    str(row[1])
                    for row in self._connection.execute("PRAGMA table_info(summaries)").fetchall()
                }
                if "archived_at" not in summary_columns:
                    self._connection.execute(
                        "ALTER TABLE summaries ADD COLUMN archived_at REAL NOT NULL DEFAULT 0"
                    )
                memory_columns = {
                    str(row[1])
                    for row in self._connection.execute("PRAGMA table_info(memories)").fetchall()
                }
                if "occurred_at" not in memory_columns:
                    self._connection.execute(
                        "ALTER TABLE memories ADD COLUMN occurred_at REAL NOT NULL DEFAULT 0"
                    )
                self._connection.execute(
                    "UPDATE memories SET occurred_at = created_at WHERE occurred_at = 0"
                )
                for column, ddl in (
                    ("confidence", "REAL NOT NULL DEFAULT 0.7"),
                    ("strength", "REAL NOT NULL DEFAULT 0.5"),
                    ("state", "TEXT NOT NULL DEFAULT 'active'"),
                    ("pinned", "INTEGER NOT NULL DEFAULT 0"),
                ):
                    if column not in memory_columns:
                        self._connection.execute(f"ALTER TABLE memories ADD COLUMN {column} {ddl}")
                period_columns = {
                    str(row[1])
                    for row in self._connection.execute(
                        "PRAGMA table_info(memory_periods)"
                    ).fetchall()
                }
                for column, ddl in (
                    ("strength", "REAL NOT NULL DEFAULT 0.5"),
                    ("state", "TEXT NOT NULL DEFAULT 'active'"),
                    ("pinned", "INTEGER NOT NULL DEFAULT 0"),
                ):
                    if column not in period_columns:
                        self._connection.execute(
                            f"ALTER TABLE memory_periods ADD COLUMN {column} {ddl}"
                        )
                self._connection.execute("DELETE FROM memory_periods_fts")
                self._connection.executemany(
                    "INSERT INTO memory_periods_fts (rowid, body) VALUES (?, ?)",
                    [
                        (int(row[0]), to_fts_body(str(row[1]) + " " + str(row[2])))
                        for row in self._connection.execute(
                            "SELECT id, summary, label FROM memory_periods"
                        ).fetchall()
                    ],
                )
                if not fresh:
                    self._verify_migration(before, guard)
                self._connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                self._connection.commit()
                if not fresh:
                    log_event(
                        LOGGER,
                        logging.INFO,
                        module="adapters.memory",
                        event="memory.schema_migrated",
                        message="记忆库结构已迁移",
                        fields={
                            "from": version,
                            "to": SCHEMA_VERSION,
                            "backup": "" if guard is None else guard.name,
                        },
                    )
            except sqlcipher.OperationalError as exc:
                raise self._translate(exc) from exc
            except sqlcipher.Error as exc:
                raise MemoryBackendError(f"记忆库初始化失败：{exc}") from exc

    # ---- 迁移安全（D3） ---------------------------------------------------

    def _has_tables(self) -> bool:
        row = self._connection.execute(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()
        return bool(row and int(row[0]) > 0)

    def _table_counts(self) -> dict[str, int]:
        """迁移前的行数基线；老库里还没有的表直接跳过（它们会被 _SCHEMA 建出来）。"""
        counts: dict[str, int] = {}
        for table in COUNTED_TABLES:
            try:
                row = self._connection.execute(f"SELECT count(*) FROM {table}").fetchone()
            except sqlite3.Error:
                continue
            if row is not None:
                counts[table] = int(row[0])
        return counts

    def _pre_migration_backup(self, version: int) -> Path | None:
        """VACUUM INTO backups/memories-pre-v{旧版本}-{时间}.db；失败只记日志、不挡迁移。

        迁移本身是加表加列（幂等、不删数据），留底是后悔药而不是前置条件：磁盘满时
        卡住启动比「带着告警继续」更糟。真出问题时这条日志里有文件名可查。
        """
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self._clock()))
        target = self._path.parent / BACKUP_DIR_NAME / f"memories-pre-v{version}-{stamp}.db"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.unlink(missing_ok=True)
            self._connection.execute("VACUUM INTO ?", (str(target),))
        except (sqlite3.Error, OSError) as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="adapters.memory",
                event="memory.schema_backup_failed",
                message="迁移前留底失败，继续迁移",
                fields={"version": version, "error": type(exc).__name__, "detail": str(exc)},
            )
            return None
        self._prune_pre_migration(version)
        log_event(
            LOGGER,
            logging.INFO,
            module="adapters.memory",
            event="memory.schema_backup",
            message="迁移前已留底",
            fields={"version": version, "file": target.name, "size": target.stat().st_size},
        )
        return target

    def _prune_pre_migration(self, version: int) -> None:
        files = sorted((self._path.parent / BACKUP_DIR_NAME).glob(f"memories-pre-v{version}-*.db"))
        for stale in files[: max(0, len(files) - PRE_MIGRATION_KEEP)]:
            try:
                stale.unlink()
            except OSError:  # pragma: no cover - 删不掉不影响迁移
                continue

    def _verify_migration(self, before: dict[str, int], guard: Path | None) -> None:
        """迁移自检：行数不能少，FTS 索引必须完整；不通过就抛错（带上留底文件名）。"""
        hint = f"；迁移前的库已留底为 {guard.name}" if guard is not None else ""
        for table, expected in before.items():
            row = self._connection.execute(f"SELECT count(*) FROM {table}").fetchone()
            actual = 0 if row is None else int(row[0])
            if actual < expected:
                raise MemoryBackendError(
                    f"记忆库迁移自检失败：{table} 从 {expected} 行变成 {actual} 行{hint}"
                )
        for fts in FTS_TABLES:
            try:
                self._connection.execute(f"INSERT INTO {fts}({fts}) VALUES('integrity-check')")
            except sqlite3.Error as exc:
                raise MemoryBackendError(f"记忆库迁移后 {fts} 索引损坏：{exc}{hint}") from exc
