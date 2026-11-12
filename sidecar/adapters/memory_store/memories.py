"""L1 记忆条目：写入/去重、检索（FTS + 向量）、列出、修改、按时间清理。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    FactSnippet,
    MemoryDraft,
    MemoryQuery,
    MemoryRecord,
    RecallQuery,
    clamp_importance,
    normalize_memory_text,
    score_memory,
    to_fts_body,
    to_fts_query,
)

from .base import MemoryStoreBase
from .rows import _to_record


class MemoriesMixin(MemoryStoreBase):
    """L1 记忆条目：写入/去重、检索（FTS + 向量）、列出、修改、按时间清理。"""

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
                    "source, source_msg_ids, occurred_at, confidence, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                        0.7,
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
        """检索 L0 片段：有可检索词走 FTS5，没有就退化成「最近写的几条」。

        exclude_kinds 用来把「行为观察」这类派生条目挡在用户事实之外（T2.1c）：
        它们不参与全文检索，否则会挤掉用户真正说过的话。
        """
        match = to_fts_query(query.query)
        limit = max(1, query.limit)
        excluded = [kind for kind in query.exclude_kinds if kind]
        not_in = ""
        if excluded:
            not_in = " AND m.kind NOT IN (" + ", ".join("?" for _ in excluded) + ")"
        with self._lock:
            try:
                if match:
                    rows = self._connection.execute(
                        "SELECT m.id, m.kind, m.text, m.importance, m.occurred_at, "
                        "bm25(memories_fts) AS rank FROM memories_fts "
                        "JOIN memories m ON m.id = memories_fts.rowid "
                        "WHERE memories_fts MATCH ? AND m.char_id = ? AND m.importance >= ? "
                        "AND m.state != 'archived'" + not_in + " ORDER BY rank ASC LIMIT ?",
                        (match, query.char_id, query.min_importance, *excluded, limit * 3),
                    ).fetchall()
                else:
                    rows = self._connection.execute(
                        "SELECT m.id, m.kind, m.text, m.importance, m.occurred_at, 0.0 AS rank "
                        "FROM memories m WHERE m.char_id = ? AND m.importance >= ? "
                        "AND m.state != 'archived'"
                        + not_in
                        + " ORDER BY m.created_at DESC LIMIT ?",
                        (query.char_id, query.min_importance, *excluded, limit * 3),
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
        conditions = ["char_id = ?", "importance >= ?", "state != 'archived'"]
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
        return [_to_record(row) for row in rows]

    def delete_memory(self, memory_id: int) -> bool:
        """删除一条记忆（连同索引行）；不存在返回 False 而不是报错。"""
        with self._lock:
            try:
                self._drop_embeddings("memory", [memory_id])
                self._connection.execute(
                    "DELETE FROM memory_links WHERE (from_type = 'memory' AND from_id = ?) "
                    "OR (to_type = 'memory' AND to_id = ?)",
                    (memory_id, memory_id),
                )
                cursor = self._connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
                self._connection.execute("DELETE FROM memories_fts WHERE rowid = ?", (memory_id,))
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)

    def get_memory(self, memory_id: int) -> MemoryRecord | None:
        """按 id 取一条记忆；不存在返回 None。"""
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT id, char_id, kind, tier, text, importance, created_at, last_used_at, "
                    "used_count, source_msg_ids FROM memories WHERE id = ?",
                    (memory_id,),
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return None if row is None else _to_record(row)

    def update_memory(
        self,
        memory_id: int,
        *,
        text: str,
        importance: float | None = None,
        kind: str | None = None,
    ) -> tuple[MemoryRecord | None, bool]:
        """改一条 L0 记忆：重算去重键、同步 FTS；返回（记录，是否并进已有的一条）。"""
        text_key = normalize_memory_text(text)
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT char_id, importance, kind FROM memories WHERE id = ?", (memory_id,)
                ).fetchone()
                if row is None:
                    return None, False
                target = float(row[1]) if importance is None else clamp_importance(importance)
                target_kind = kind if kind is not None else str(row[2])
                clash = self._connection.execute(
                    "SELECT id, importance FROM memories WHERE char_id = ? AND text_key = ? "
                    "AND id != ?",
                    (str(row[0]), text_key, memory_id),
                ).fetchone()
                if clash is not None:
                    keep_id = int(clash[0])
                    self._connection.execute(
                        "UPDATE memories SET importance = ? WHERE id = ?",
                        (max(float(clash[1]), target), keep_id),
                    )
                    self._connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
                    self._connection.execute(
                        "DELETE FROM memories_fts WHERE rowid = ?", (memory_id,)
                    )
                    self._drop_embeddings("memory", [memory_id])
                    self._connection.commit()
                    return self.get_memory(keep_id), True
                self._connection.execute(
                    "UPDATE memories SET text = ?, text_key = ?, importance = ?, kind = ? "
                    "WHERE id = ?",
                    (text, text_key, target, target_kind, memory_id),
                )
                cursor = self._connection.execute(
                    "UPDATE memories_fts SET body = ? WHERE rowid = ?",
                    (to_fts_body(text), memory_id),
                )
                if not cursor.rowcount:
                    self._connection.execute(
                        "INSERT INTO memories_fts (rowid, body) VALUES (?, ?)",
                        (memory_id, to_fts_body(text)),
                    )
                self._drop_embeddings("memory", [memory_id])
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return self.get_memory(memory_id), False

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
                    period_ids = [
                        int(row[0])
                        for row in self._connection.execute(
                            "SELECT id FROM memory_periods WHERE char_id = ?", (char_id,)
                        ).fetchall()
                    ]
                    self._connection.execute("DELETE FROM memories WHERE char_id = ?", (char_id,))
                    self._connection.execute("DELETE FROM summaries WHERE char_id = ?", (char_id,))
                    self._connection.execute(
                        "DELETE FROM memory_periods WHERE char_id = ?", (char_id,)
                    )
                    self._connection.execute(
                        "DELETE FROM diary_entries WHERE char_id = ?", (char_id,)
                    )
                    self._connection.execute(
                        "DELETE FROM memory_intentions WHERE char_id = ?", (char_id,)
                    )
                    self._connection.execute(
                        "DELETE FROM memory_relations WHERE char_id = ?", (char_id,)
                    )
                    self._connection.execute(
                        "DELETE FROM memory_links WHERE char_id = ?", (char_id,)
                    )
                    self._connection.execute(
                        "DELETE FROM memory_entities WHERE char_id = ?", (char_id,)
                    )
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
                    period_ids = [
                        int(row[0])
                        for row in self._connection.execute(
                            "SELECT id FROM memory_periods WHERE char_id = ? AND period_end < ?",
                            (char_id, cutoff),
                        ).fetchall()
                    ]
                    self._connection.execute(
                        "DELETE FROM memory_periods WHERE char_id = ? AND period_end < ?",
                        (char_id, cutoff),
                    )
                    self._connection.execute(
                        "DELETE FROM diary_entries WHERE char_id = ? AND occurred_at < ?",
                        (char_id, cutoff),
                    )
                self._drop_embeddings("memory", ids)
                for memory_id in ids:
                    self._connection.execute(
                        "DELETE FROM memories_fts WHERE rowid = ?", (memory_id,)
                    )
                for period_id in period_ids:
                    self._connection.execute(
                        "DELETE FROM memory_periods_fts WHERE rowid = ?", (period_id,)
                    )
                self._drop_embeddings("period", period_ids)
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
                    "UPDATE memories SET last_used_at = ?, used_count = used_count + 1, "
                    "strength = MIN(1.0, strength + 0.15), state = 'active' "
                    f"WHERE id IN ({placeholders})",
                    (now, *memory_ids),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.rowcount or 0)
