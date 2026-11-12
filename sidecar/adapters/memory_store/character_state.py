"""角色状态：好感/心情这类随角色存一份的小状态，以及重置。"""

from __future__ import annotations

from sqlcipher3 import dbapi2 as sqlcipher

from core.character_state import CharacterState

from .base import MemoryStoreBase


class CharacterStateMixin(MemoryStoreBase):
    """角色状态：好感/心情这类随角色存一份的小状态，以及重置。"""

    def load_character_state(self, char_id: str) -> CharacterState | None:
        """读取角色的内在状态；没有记录返回 None。"""
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT relation_json, mood_json, last_seen_ts, last_proactive_ts, "
                    "proactive_ignored_streak, updated_at FROM state WHERE char_id = ?",
                    (char_id,),
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        if row is None:
            return None
        return CharacterState.from_storage(
            char_id,
            relation_json=str(row[0] or ""),
            mood_json=str(row[1] or ""),
            last_seen_ts=float(row[2] or 0.0),
            last_proactive_ts=float(row[3] or 0.0),
            ignored_streak=int(row[4] or 0),
            updated_at=float(row[5] or 0.0),
        )

    def save_character_state(self, state: CharacterState) -> None:
        """写入角色的内在状态；按 char_id 幂等 upsert。"""
        relation, mood, last_seen, last_proactive, ignored, updated = state.to_storage()
        with self._lock:
            try:
                self._connection.execute(
                    "INSERT INTO state (char_id, relation_json, mood_json, last_seen_ts, "
                    "last_proactive_ts, proactive_ignored_streak, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(char_id) DO UPDATE SET "
                    "relation_json = excluded.relation_json, "
                    "mood_json = excluded.mood_json, "
                    "last_seen_ts = excluded.last_seen_ts, "
                    "last_proactive_ts = excluded.last_proactive_ts, "
                    "proactive_ignored_streak = excluded.proactive_ignored_streak, "
                    "updated_at = excluded.updated_at",
                    (
                        state.char_id,
                        relation,
                        mood,
                        last_seen,
                        last_proactive,
                        int(ignored),
                        updated,
                    ),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc

    def reset_character(self, char_id: str) -> dict[str, int]:
        """完整重置一个角色：原文、事实、摘要、状态全部删除。"""
        with self._lock:
            try:
                message_ids = [
                    int(row[0])
                    for row in self._connection.execute(
                        "SELECT id FROM messages WHERE char_id = ?", (char_id,)
                    ).fetchall()
                ]
                memory_ids = [
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
                for message_id in message_ids:
                    self._connection.execute(
                        "DELETE FROM messages_fts WHERE rowid = ?", (message_id,)
                    )
                for memory_id in memory_ids:
                    self._connection.execute(
                        "DELETE FROM memories_fts WHERE rowid = ?", (memory_id,)
                    )
                for period_id in period_ids:
                    self._connection.execute(
                        "DELETE FROM memory_periods_fts WHERE rowid = ?", (period_id,)
                    )
                self._drop_embeddings("period", period_ids)
                self._connection.execute("DELETE FROM messages WHERE char_id = ?", (char_id,))
                self._connection.execute("DELETE FROM memories WHERE char_id = ?", (char_id,))
                self._connection.execute("DELETE FROM summaries WHERE char_id = ?", (char_id,))
                self._connection.execute("DELETE FROM memory_periods WHERE char_id = ?", (char_id,))
                self._connection.execute("DELETE FROM diary_entries WHERE char_id = ?", (char_id,))
                self._connection.execute(
                    "DELETE FROM memory_intentions WHERE char_id = ?", (char_id,)
                )
                self._connection.execute(
                    "DELETE FROM memory_relations WHERE char_id = ?", (char_id,)
                )
                self._connection.execute("DELETE FROM memory_links WHERE char_id = ?", (char_id,))
                self._connection.execute(
                    "DELETE FROM memory_entities WHERE char_id = ?", (char_id,)
                )
                self._connection.execute(
                    "DELETE FROM memory_embeddings WHERE char_id = ?", (char_id,)
                )
                self._connection.execute("DELETE FROM state WHERE char_id = ?", (char_id,))
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        self._vacuum()
        return {
            "messages": len(message_ids),
            "memories": len(memory_ids),
        }
