"""日记：按角色增删改查。"""

from __future__ import annotations

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    DEFAULT_DIARY_LIMIT,
    DiaryDraft,
    DiaryEntry,
    MemoryBackendError,
)

from .base import MemoryStoreBase
from .rows import _to_diary


class DiaryMixin(MemoryStoreBase):
    """日记：按角色增删改查。"""

    def list_diary(self, char_id: str, *, limit: int = DEFAULT_DIARY_LIMIT) -> list[DiaryEntry]:
        if limit <= 0:
            return []
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, text, occurred_at, mood, tags, created_at, updated_at "
                    "FROM diary_entries WHERE char_id = ? "
                    "ORDER BY occurred_at DESC, id DESC LIMIT ?",
                    (char_id, max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_diary(row) for row in rows]

    def get_diary(self, entry_id: int) -> DiaryEntry | None:
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT id, char_id, text, occurred_at, mood, tags, created_at, updated_at "
                    "FROM diary_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return None if row is None else _to_diary(row)

    def add_diary(self, draft: DiaryDraft, *, now: float = 0.0) -> DiaryEntry:
        body = draft.text.strip()
        if not body:
            raise MemoryBackendError("日记正文不能为空")
        moment = float(now or self._clock())
        occurred = float(draft.occurred_at or moment)
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "INSERT INTO diary_entries (char_id, text, occurred_at, mood, tags, "
                    "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (draft.char_id, body, occurred, draft.mood, draft.tags, moment, moment),
                )
                entry_id = int(cursor.lastrowid or 0)
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return DiaryEntry(
            entry_id=entry_id,
            char_id=draft.char_id,
            text=body,
            occurred_at=occurred,
            mood=draft.mood,
            tags=draft.tags,
            created_at=moment,
            updated_at=moment,
        )

    def update_diary(
        self, entry_id: int, *, text: str, mood: str | None = None, tags: str | None = None
    ) -> DiaryEntry | None:
        body = text.strip()
        if not body:
            raise MemoryBackendError("日记正文不能为空")
        moment = self._clock()
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT char_id, occurred_at, mood, tags, created_at "
                    "FROM diary_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
                if row is None:
                    return None
                next_mood = str(row[2]) if mood is None else mood
                next_tags = str(row[3]) if tags is None else tags
                self._connection.execute(
                    "UPDATE diary_entries SET text = ?, mood = ?, tags = ?, updated_at = ? "
                    "WHERE id = ?",
                    (body, next_mood, next_tags, moment, entry_id),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return DiaryEntry(
            entry_id=entry_id,
            char_id=str(row[0]),
            text=body,
            occurred_at=float(row[1]),
            mood=next_mood,
            tags=next_tags,
            created_at=float(row[4]),
            updated_at=moment,
        )

    def delete_diary(self, entry_id: int) -> bool:
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "DELETE FROM diary_entries WHERE id = ?", (entry_id,)
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)
