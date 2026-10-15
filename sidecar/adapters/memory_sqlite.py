"""文件职责：SQLCipher 记忆库（需求 §6.4 四层阶梯 / §6.5 整库加密）。

依赖方向：adapters → core（只用 core.memory 的数据类型与异常）；不 import services。
谁调用：services.memory_service 通过 MemoryStore 协议使用；composition root 负责建库。
线程安全：一条连接 + 一把可重入锁（FastAPI 的同步端点可能落在线程池里）。
"""

from __future__ import annotations

import contextlib
import sqlite3
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    FactSnippet,
    MemoryBackendError,
    MemoryDraft,
    MemoryIndexBrokenError,
    MemoryKeyInvalidError,
    MemoryQuery,
    MemoryReadonlyError,
    MemoryRecord,
    MessageDraft,
    MessageRow,
    RecallQuery,
    SummarySnippet,
    clamp_importance,
    normalize_memory_text,
    score_memory,
    to_fts_body,
    to_fts_query,
)

#: 库结构版本（PRAGMA user_version）：以后加表 / 加列就 +1，并在 _ensure_schema 里写迁移。
SCHEMA_VERSION = 1

ConnectionFactory = Callable[[str], Any]
Clock = Callable[[], float]

_SCHEMA = """
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
    created_at REAL NOT NULL,
    last_used_at REAL,
    used_count INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedup ON memories(char_id, text_key);
CREATE INDEX IF NOT EXISTS idx_memories_char_created ON memories(char_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(body, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    text TEXT NOT NULL,
    covers_from REAL NOT NULL,
    covers_to REAL NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_char_tier ON summaries(char_id, tier, created_at);

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


class MemorySqliteStore:
    """MemoryStore 的 SQLCipher 实现（唯一落盘实现）。"""

    def __init__(
        self,
        path: Path,
        *,
        key: bytes,
        connection_factory: ConnectionFactory | None = None,
        clock: Clock | None = None,
    ) -> None:
        if len(key) != 32:
            raise MemoryKeyInvalidError(f"记忆库密钥必须是 32 字节，收到 {len(key)} 字节")
        self._path = path
        self._key = key
        self._clock = clock or time.time
        self._lock = threading.RLock()
        factory = connection_factory or self._connect
        self._connection: Any = factory(str(path))
        try:
            key_literal = f"x'{key.hex()}'"
            self._connection.execute(f'PRAGMA key = "{key_literal}"')
            self._connection.execute("PRAGMA busy_timeout = 5000")
        except sqlcipher.Error as exc:  # pragma: no cover - 只在库文件被换成明文时触发
            raise MemoryKeyInvalidError(f"记忆库密钥无法应用：{exc}") from exc
        # 关键：PRAGMA key 之后必须真的读一次库，才能知道密钥对不对
        # （SQLCipher 的错配错误是在第一次读页时才报出来的）。
        try:
            self._connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except sqlcipher.DatabaseError as exc:
            raise MemoryKeyInvalidError("记忆库密钥与库文件不匹配，或库文件已损坏") from exc
        self._setup_pragmas()
        self._ensure_schema()

    # ---- 生命周期 ---------------------------------------------------------

    def _connect(self, path: str) -> Any:
        return sqlcipher.connect(path, check_same_thread=False)

    def _setup_pragmas(self) -> None:
        for statement in (
            "PRAGMA journal_mode = WAL",
            "PRAGMA synchronous = NORMAL",
            "PRAGMA foreign_keys = ON",
        ):
            try:
                self._connection.execute(statement)
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc

    def _ensure_schema(self) -> None:
        with self._lock:
            version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise MemoryBackendError(
                    f"记忆库版本 {version} 高于本程序支持的 {SCHEMA_VERSION}，请更新 deskpet"
                )
            if version == SCHEMA_VERSION:
                return
            try:
                self._connection.executescript(_SCHEMA)
                self._connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                self._connection.commit()
            except sqlcipher.OperationalError as exc:
                raise self._translate(exc) from exc
            except sqlcipher.Error as exc:
                raise MemoryBackendError(f"记忆库初始化失败：{exc}") from exc

    def _translate(self, exc: sqlite3.Error) -> MemoryBackendError:
        """把 sqlite 的报错翻译成服务层能映射成 DP-MEM-* 的异常。"""
        message = str(exc).lower()
        readonly_markers = ("readonly", "unable to open database file", "attempt to write")
        if any(marker in message for marker in readonly_markers):
            return MemoryReadonlyError(f"记忆库不可写：{exc}")
        if "fts5" in message or "no such module" in message or "malformed" in message:
            return MemoryIndexBrokenError(f"记忆库全文索引不可用：{exc}")
        return MemoryBackendError(f"记忆库操作失败：{exc}")

    def close(self) -> None:
        """关闭连接（幂等）。"""
        # 关闭失败没有补救动作
        with self._lock, contextlib.suppress(sqlcipher.Error):
            self._connection.close()

    @property
    def path(self) -> Path:
        """库文件路径（日志与排查用）。"""
        return self._path

    # ---- L0 原文 ----------------------------------------------------------

    def add_messages(self, drafts: Sequence[MessageDraft]) -> tuple[int, ...]:
        """按顺序落库一批历史消息，并同步写全文索引。"""
        ids: list[int] = []
        with self._lock:
            try:
                for draft in drafts:
                    cursor = self._connection.execute(
                        "INSERT INTO messages (char_id, session_id, role, text, ts, token_len) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            draft.char_id,
                            draft.session_id,
                            draft.role,
                            draft.text,
                            draft.ts,
                            draft.token_len,
                        ),
                    )
                    message_id = int(cursor.lastrowid or 0)
                    self._connection.execute(
                        "INSERT INTO messages_fts (rowid, body) VALUES (?, ?)",
                        (message_id, to_fts_body(draft.text)),
                    )
                    ids.append(message_id)
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return tuple(ids)

    def recent_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        """取该角色最近 limit 条历史消息，按时间升序返回。"""
        if limit <= 0:
            return []
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, session_id, role, text, ts, token_len FROM messages "
                    "WHERE char_id = ? ORDER BY id DESC LIMIT ?",
                    (char_id, limit),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        ordered = list(reversed(rows))
        return [
            MessageRow(
                message_id=int(row[0]),
                char_id=str(row[1]),
                session_id=str(row[2]),
                role=str(row[3]),
                text=str(row[4]),
                ts=float(row[5]),
                token_len=int(row[6]),
            )
            for row in ordered
        ]

    def count_messages(self, char_id: str) -> int:
        """该角色累计落库的消息条数。"""
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT count(*) FROM messages WHERE char_id = ?", (char_id,)
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(row[0]) if row else 0

    def uncovered_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        """按时间升序取尚未被摘要覆盖的旧消息（T2.1b 的摘要输入）。"""
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, session_id, role, text, ts, token_len FROM messages "
                    "WHERE char_id = ? AND covered_by = 0 ORDER BY id ASC LIMIT ?",
                    (char_id, limit),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [
            MessageRow(
                message_id=int(row[0]),
                char_id=str(row[1]),
                session_id=str(row[2]),
                role=str(row[3]),
                text=str(row[4]),
                ts=float(row[5]),
                token_len=int(row[6]),
            )
            for row in rows
        ]

    def mark_covered(self, message_ids: Sequence[int], *, summary_id: int) -> int:
        """把消息标记为已被某条摘要覆盖（不删除原文）。"""
        if not message_ids:
            return 0
        placeholders = ",".join("?" for _ in message_ids)
        with self._lock:
            try:
                cursor = self._connection.execute(
                    f"UPDATE messages SET covered_by = ? WHERE id IN ({placeholders})",
                    (summary_id, *message_ids),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.rowcount or 0)

    # ---- 记忆（L0 事实） --------------------------------------------------

    def upsert_memory(self, draft: MemoryDraft, *, now: float) -> tuple[int, bool]:
        """写入一条记忆；同一角色 + 归一化文本相同视为重复，只抬重要度。"""
        text_key = normalize_memory_text(draft.text)
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT id, importance FROM memories WHERE char_id = ? AND text_key = ?",
                    (draft.char_id, text_key),
                ).fetchone()
                if row is not None:
                    memory_id = int(row[0])
                    self._connection.execute(
                        "UPDATE memories SET importance = ?, source_msg_ids = ? WHERE id = ?",
                        (
                            max(float(row[1]), clamp_importance(draft.importance)),
                            draft.source_msg_ids,
                            memory_id,
                        ),
                    )
                    self._connection.commit()
                    return memory_id, True
                created_at = float(draft.occurred_at or now)
                cursor = self._connection.execute(
                    "INSERT INTO memories (char_id, kind, tier, text, text_key, importance, "
                    "source, source_msg_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        draft.char_id,
                        draft.kind,
                        draft.tier,
                        draft.text,
                        text_key,
                        clamp_importance(draft.importance),
                        draft.source,
                        draft.source_msg_ids,
                        created_at,
                    ),
                )
                memory_id = int(cursor.lastrowid or 0)
                self._connection.execute(
                    "INSERT INTO memories_fts (rowid, body) VALUES (?, ?)",
                    (memory_id, to_fts_body(draft.text)),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return memory_id, False

    def search_memories(self, query: RecallQuery) -> list[FactSnippet]:
        """检索 L0 片段：有可检索词走 FTS5，没有就退化成「最近写的几条」。"""
        match = to_fts_query(query.query)
        limit = max(1, query.limit)
        with self._lock:
            try:
                if match:
                    rows = self._connection.execute(
                        "SELECT m.id, m.kind, m.text, m.importance, m.created_at, "
                        "bm25(memories_fts) AS rank FROM memories_fts "
                        "JOIN memories m ON m.id = memories_fts.rowid "
                        "WHERE memories_fts MATCH ? AND m.char_id = ? AND m.importance >= ? "
                        "ORDER BY rank ASC LIMIT ?",
                        (match, query.char_id, query.min_importance, limit * 3),
                    ).fetchall()
                else:
                    rows = self._connection.execute(
                        "SELECT m.id, m.kind, m.text, m.importance, m.created_at, 0.0 AS rank "
                        "FROM memories m WHERE m.char_id = ? AND m.importance >= ? "
                        "ORDER BY m.created_at DESC LIMIT ?",
                        (query.char_id, query.min_importance, limit * 3),
                    ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        hits = [
            FactSnippet(
                memory_id=int(row[0]),
                kind=str(row[1]),
                text=str(row[2]),
                importance=float(row[3]),
                score=score_memory(
                    rank=float(row[5]),
                    importance=float(row[3]),
                    occurred_at=float(row[4]),
                    now=query.now,
                ),
                occurred_at=float(row[4]),
            )
            for row in rows
        ]
        hits.sort(key=lambda hit: hit.score, reverse=True)
        return hits[:limit]

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        """按重要度 + 新鲜度列出记忆（管理界面；不做全文检索）。"""
        conditions = ["char_id = ?", "importance >= ?"]
        params: list[Any] = [query.char_id, query.min_importance]
        if query.kind:
            conditions.append("kind = ?")
            params.append(query.kind)
        if query.tier:
            conditions.append("tier = ?")
            params.append(query.tier)
        params.append(max(1, query.limit))
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, kind, tier, text, importance, created_at, last_used_at, "
                    "used_count, source_msg_ids FROM memories WHERE "
                    + " AND ".join(conditions)
                    + " ORDER BY importance DESC, created_at DESC LIMIT ?",
                    tuple(params),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [
            MemoryRecord(
                memory_id=int(row[0]),
                char_id=str(row[1]),
                kind=str(row[2]),
                tier=str(row[3]),
                text=str(row[4]),
                importance=float(row[5]),
                created_at=float(row[6]),
                last_used_at=float(row[7]) if row[7] is not None else None,
                used_count=int(row[8]),
                source_msg_ids=str(row[9]),
            )
            for row in rows
        ]

    def delete_memory(self, memory_id: int) -> bool:
        """删除一条记忆（连同索引行）；不存在返回 False 而不是报错。"""
        with self._lock:
            try:
                cursor = self._connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
                self._connection.execute("DELETE FROM memories_fts WHERE rowid = ?", (memory_id,))
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)

    def clear_memories(self, char_id: str, *, keep_days: float | None = None) -> int:
        """清空该角色的记忆与摘要；keep_days 非空时只删这个天数之前的。"""
        cutoff = None if keep_days is None else self._clock() - keep_days * 86400.0
        with self._lock:
            try:
                if cutoff is None:
                    ids = [
                        int(row[0])
                        for row in self._connection.execute(
                            "SELECT id FROM memories WHERE char_id = ?", (char_id,)
                        ).fetchall()
                    ]
                    self._connection.execute("DELETE FROM memories WHERE char_id = ?", (char_id,))
                    self._connection.execute("DELETE FROM summaries WHERE char_id = ?", (char_id,))
                else:
                    ids = [
                        int(row[0])
                        for row in self._connection.execute(
                            "SELECT id FROM memories WHERE char_id = ? AND created_at < ?",
                            (char_id, cutoff),
                        ).fetchall()
                    ]
                    self._connection.execute(
                        "DELETE FROM memories WHERE char_id = ? AND created_at < ?",
                        (char_id, cutoff),
                    )
                    self._connection.execute(
                        "DELETE FROM summaries WHERE char_id = ? AND covers_to < ?",
                        (char_id, cutoff),
                    )
                for memory_id in ids:
                    self._connection.execute(
                        "DELETE FROM memories_fts WHERE rowid = ?", (memory_id,)
                    )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return len(ids)

    def mark_used(self, memory_ids: Sequence[int], *, now: float) -> int:
        """把注入过的记忆记为「用过一次」（T2.6 的偏好加权会用）。"""
        if not memory_ids:
            return 0
        placeholders = ",".join("?" for _ in memory_ids)
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "UPDATE memories SET last_used_at = ?, used_count = used_count + 1 "
                    f"WHERE id IN ({placeholders})",
                    (now, *memory_ids),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.rowcount or 0)

    # ---- 阶梯摘要 ---------------------------------------------------------

    def add_summary(
        self,
        *,
        char_id: str,
        tier: int,
        text: str,
        covers_from: float,
        covers_to: float,
        source_ids: str = "",
        now: float = 0.0,
    ) -> int:
        """追加一条阶梯摘要（L1 / L2 / L3），返回 id。"""
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "INSERT INTO summaries (char_id, tier, text, covers_from, covers_to, "
                    "source_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        char_id,
                        int(tier),
                        text,
                        covers_from,
                        covers_to,
                        source_ids,
                        float(now or self._clock()),
                    ),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.lastrowid or 0)

    def latest_summary(self, char_id: str, tier: int) -> SummarySnippet | None:
        """取该层最新一条摘要。"""
        rows = self.list_summaries(char_id, tier, limit=1)
        return rows[0] if rows else None

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        """取该层最近 limit 条摘要（新的在前）。"""
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, tier, text, covers_to FROM summaries "
                    "WHERE char_id = ? AND tier = ? ORDER BY created_at DESC, id DESC LIMIT ?",
                    (char_id, int(tier), max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [
            SummarySnippet(
                summary_id=int(row[0]),
                tier=int(row[1]),
                text=str(row[2]),
                covers_to=float(row[3]),
            )
            for row in rows
        ]


def open_memory_store(
    path: Path,
    *,
    key: bytes,
    connection_factory: ConnectionFactory | None = None,
    clock: Clock | None = None,
) -> MemorySqliteStore:
    """建库（含目录与表结构）并返回 store；这是服务层唯一的开库入口。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    return MemorySqliteStore(path, key=key, connection_factory=connection_factory, clock=clock)


__all__ = [
    "SCHEMA_VERSION",
    "MemorySqliteStore",
    "open_memory_store",
]
