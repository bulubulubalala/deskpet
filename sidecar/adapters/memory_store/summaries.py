"""摘要与消息编辑：阶梯摘要的增删改查、原文编辑与删除。"""

from __future__ import annotations

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    MessageRow,
    SummarySnippet,
    estimate_tokens,
    to_fts_body,
)

from .base import MemoryStoreBase


class SummariesMixin(MemoryStoreBase):
    """摘要与消息编辑：阶梯摘要的增删改查、原文编辑与删除。"""

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

    def list_all_summaries(self, char_id: str, *, limit: int) -> list[SummarySnippet]:
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, tier, text, covers_from, covers_to, source_ids, "
                    "created_at, archived_at FROM summaries WHERE char_id = ? "
                    "ORDER BY created_at DESC, id DESC LIMIT ?",
                    (char_id, max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [
            SummarySnippet(
                summary_id=int(row[0]),
                char_id=str(row[1]),
                tier=int(row[2]),
                text=str(row[3]),
                covers_from=float(row[4]),
                covers_to=float(row[5]),
                source_ids=str(row[6]),
                created_at=float(row[7]),
                archived_at=float(row[8]),
            )
            for row in rows
        ]

    def update_summary(self, summary_id: int, *, text: str) -> SummarySnippet | None:
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "UPDATE summaries SET text = ? WHERE id = ?", (text, summary_id)
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
            if not cursor.rowcount:
                return None
            row = self._connection.execute(
                "SELECT id, char_id, tier, text, covers_from, covers_to, source_ids, "
                "created_at, archived_at FROM summaries WHERE id = ?",
                (summary_id,),
            ).fetchone()
        if row is None:
            return None
        return SummarySnippet(
            summary_id=int(row[0]),
            char_id=str(row[1]),
            tier=int(row[2]),
            text=str(row[3]),
            covers_from=float(row[4]),
            covers_to=float(row[5]),
            source_ids=str(row[6]),
            created_at=float(row[7]),
            archived_at=float(row[8]),
        )

    def delete_summary(self, summary_id: int) -> bool:
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "DELETE FROM summaries WHERE id = ?", (summary_id,)
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)

    def update_message(self, message_id: int, *, text: str) -> MessageRow | None:
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT char_id, session_id, role, ts, covered_by FROM messages WHERE id = ?",
                    (message_id,),
                ).fetchone()
                if row is None:
                    return None
                self._connection.execute(
                    "UPDATE messages SET text = ?, token_len = ? WHERE id = ?",
                    (text, estimate_tokens(text), message_id),
                )
                cursor = self._connection.execute(
                    "UPDATE messages_fts SET body = ? WHERE rowid = ?",
                    (to_fts_body(text), message_id),
                )
                if not cursor.rowcount:
                    self._connection.execute(
                        "INSERT INTO messages_fts (rowid, body) VALUES (?, ?)",
                        (message_id, to_fts_body(text)),
                    )
                self._drop_embeddings("message", [message_id])
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return MessageRow(
            message_id=message_id,
            char_id=str(row[0]),
            session_id=str(row[1]),
            role=str(row[2]),
            text=text,
            ts=float(row[3]),
            token_len=estimate_tokens(text),
            covered_by=int(row[4] or 0),
        )

    def delete_message(self, message_id: int) -> bool:
        with self._lock:
            try:
                self._drop_embeddings("message", [message_id])
                cursor = self._connection.execute(
                    "DELETE FROM messages WHERE id = ?", (message_id,)
                )
                self._connection.execute("DELETE FROM messages_fts WHERE rowid = ?", (message_id,))
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)

    def latest_summary(self, char_id: str, tier: int) -> SummarySnippet | None:
        """取该层最新一条摘要。"""
        rows = self.list_summaries(char_id, tier, limit=1)
        return rows[0] if rows else None

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        """取该层最近 limit 条摘要（新的在前）。"""
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, tier, text, covers_to, source_ids FROM summaries "
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
                source_ids=str(row[4]),
            )
            for row in rows
        ]
