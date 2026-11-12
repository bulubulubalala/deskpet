"""L0 原文与「哪条消息被摘要覆盖了」：写入、分页、计数、覆盖标记。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    DEFAULT_MESSAGE_PAGE_LIMIT,
    MessageDraft,
    MessageRow,
    to_fts_body,
)

from .base import MemoryStoreBase


class MessagesMixin(MemoryStoreBase):
    """L0 原文与「哪条消息被摘要覆盖了」：写入、分页、计数、覆盖标记。"""

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
                    "SELECT id, char_id, session_id, role, text, ts, token_len, covered_by "
                    "FROM messages WHERE char_id = ? ORDER BY id DESC LIMIT ?",
                    (char_id, limit),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        ordered = list(reversed(rows))
        return [self._message_row(row) for row in ordered]

    def list_messages(
        self,
        char_id: str,
        *,
        limit: int = DEFAULT_MESSAGE_PAGE_LIMIT,
        before_id: int | None = None,
    ) -> list[MessageRow]:
        """按 id 倒序翻历史原文（开发者模式「原文」页，T2.3-B1）。

        before_id 给了就只取更小的 id（向下翻页）；不含删除，原文只读。
        """
        if limit <= 0:
            return []
        sql = (
            "SELECT id, char_id, session_id, role, text, ts, token_len, covered_by FROM messages "
            "WHERE char_id = ?"
        )
        params: list[Any] = [char_id]
        if before_id is not None:
            sql += " AND id < ?"
            params.append(before_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._lock:
            try:
                rows = self._connection.execute(sql, tuple(params)).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [self._message_row(row) for row in rows]

    def oldest_message_ts(self, char_id: str) -> float:
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT min(ts) FROM messages WHERE char_id = ?", (char_id,)
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return float(row[0] or 0.0) if row is not None else 0.0

    def list_character_ids(self) -> list[str]:
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT char_id FROM messages UNION "
                    "SELECT char_id FROM memories UNION "
                    "SELECT char_id FROM diary_entries UNION "
                    "SELECT char_id FROM memory_periods ORDER BY char_id"
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [str(row[0]) for row in rows]

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
                    "SELECT id, char_id, session_id, role, text, ts, token_len, covered_by "
                    "FROM messages WHERE char_id = ? AND covered_by = 0 ORDER BY id ASC LIMIT ?",
                    (char_id, limit),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [self._message_row(row) for row in rows]

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

    def mark_summaries_archived(self, summary_ids: Sequence[int], *, now: float) -> int:
        """标记下层摘要已被成功聚合；到期清理从这一刻开始计时。"""
        if not summary_ids:
            return 0
        placeholders = ",".join("?" for _ in summary_ids)
        with self._lock:
            try:
                cursor = self._connection.execute(
                    f"UPDATE summaries SET archived_at = ? WHERE id IN ({placeholders})",
                    (now, *summary_ids),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.rowcount or 0)

    def messages_between(self, char_id: str, *, start: float, end: float) -> list[MessageRow]:
        """取某段时间内的原文（时间升序）；end <= start 表示不限结束时间。"""
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, session_id, role, text, ts, token_len, covered_by "
                    "FROM messages WHERE char_id = ? AND ts >= ?"
                    + (" AND ts < ?" if end > start else "")
                    + " ORDER BY ts ASC, id ASC",
                    (char_id, start, end) if end > start else (char_id, start),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [MessageRow(*row) for row in rows]
