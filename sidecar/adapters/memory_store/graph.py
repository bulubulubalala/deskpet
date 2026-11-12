"""关系图谱与待办：实体、关系边、意图（intention）的存取。"""

from __future__ import annotations

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    DEFAULT_INTENTION_LIMIT,
    MemoryBackendError,
    MemoryEntity,
    MemoryIntention,
    MemoryLink,
    MemoryRelation,
)

from .base import MemoryStoreBase
from .rows import _to_entity, _to_intention, _to_link


class GraphMixin(MemoryStoreBase):
    """关系图谱与待办：实体、关系边、意图（intention）的存取。"""

    def list_intentions(
        self, char_id: str, *, limit: int = DEFAULT_INTENTION_LIMIT
    ) -> list[MemoryIntention]:
        if limit <= 0:
            return []
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, text, trigger_at, trigger_context, status, "
                    "created_at, resolved_at FROM memory_intentions "
                    "WHERE char_id = ? AND status = 'open' "
                    "ORDER BY CASE WHEN trigger_at > 0 THEN trigger_at ELSE created_at END ASC "
                    "LIMIT ?",
                    (char_id, max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_intention(row) for row in rows]

    def add_intention(
        self,
        *,
        char_id: str,
        text: str,
        trigger_at: float = 0.0,
        trigger_context: str = "",
        now: float = 0.0,
    ) -> MemoryIntention:
        body = text.strip()
        if not body:
            raise MemoryBackendError("前瞻记忆不能为空")
        moment = float(now or self._clock())
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "INSERT INTO memory_intentions (char_id, text, trigger_at, "
                    "trigger_context, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
                    (char_id, body, float(trigger_at), trigger_context, moment),
                )
                intention_id = int(cursor.lastrowid or 0)
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return MemoryIntention(
            intention_id=intention_id,
            char_id=char_id,
            text=body,
            trigger_at=float(trigger_at),
            trigger_context=trigger_context,
            status="open",
            created_at=moment,
        )

    def resolve_intention(self, intention_id: int, *, now: float = 0.0) -> bool:
        moment = float(now or self._clock())
        with self._lock:
            try:
                cursor = self._connection.execute(
                    "UPDATE memory_intentions SET status = 'done', resolved_at = ? "
                    "WHERE id = ? AND status = 'open'",
                    (moment, intention_id),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)

    def upsert_entity(
        self,
        *,
        char_id: str,
        name: str,
        kind: str = "topic",
        aliases: str = "",
        now: float = 0.0,
    ) -> int:
        body = " ".join(name.split())
        if not body:
            raise MemoryBackendError("实体名不能为空")
        moment = float(now or self._clock())
        with self._lock:
            try:
                self._connection.execute(
                    "INSERT INTO memory_entities (char_id, name, kind, aliases, "
                    "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(char_id, name) DO UPDATE SET kind = excluded.kind, "
                    "aliases = excluded.aliases, updated_at = excluded.updated_at",
                    (char_id, body, kind or "topic", aliases, moment, moment),
                )
                row = self._connection.execute(
                    "SELECT id FROM memory_entities WHERE char_id = ? AND name = ?",
                    (char_id, body),
                ).fetchone()
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(row[0]) if row is not None else 0

    def list_entities(self, char_id: str, *, limit: int = 100) -> list[MemoryEntity]:
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, name, kind, aliases, created_at, updated_at "
                    "FROM memory_entities WHERE char_id = ? ORDER BY updated_at DESC LIMIT ?",
                    (char_id, max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_entity(row) for row in rows]

    def upsert_link(
        self,
        *,
        char_id: str,
        from_type: str,
        from_id: int,
        to_type: str,
        to_id: int,
        relation: str,
        weight: float = 1.0,
        confidence: float = 0.7,
        now: float = 0.0,
    ) -> int:
        moment = float(now or self._clock())
        with self._lock:
            try:
                self._connection.execute(
                    "INSERT INTO memory_links (char_id, from_type, from_id, to_type, "
                    "to_id, relation, weight, confidence, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(char_id, from_type, from_id, to_type, to_id, relation) "
                    "DO UPDATE SET weight = excluded.weight, confidence = excluded.confidence",
                    (
                        char_id,
                        from_type,
                        int(from_id),
                        to_type,
                        int(to_id),
                        relation,
                        float(weight),
                        float(confidence),
                        moment,
                    ),
                )
                row = self._connection.execute(
                    "SELECT id FROM memory_links WHERE char_id = ? AND from_type = ? "
                    "AND from_id = ? AND to_type = ? AND to_id = ? AND relation = ?",
                    (char_id, from_type, int(from_id), to_type, int(to_id), relation),
                ).fetchone()
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(row[0]) if row is not None else 0

    def list_links(self, char_id: str, *, limit: int = 200) -> list[MemoryLink]:
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, from_type, from_id, to_type, to_id, relation, "
                    "weight, confidence, created_at FROM memory_links "
                    "WHERE char_id = ? ORDER BY confidence DESC, id DESC LIMIT ?",
                    (char_id, max(1, limit)),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_link(row) for row in rows]

    def clear_graph(self, char_id: str) -> dict[str, int]:
        with self._lock:
            try:
                links = self._connection.execute(
                    "DELETE FROM memory_links WHERE char_id = ?", (char_id,)
                )
                entities = self._connection.execute(
                    "DELETE FROM memory_entities WHERE char_id = ?", (char_id,)
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return {"entities": int(entities.rowcount or 0), "links": int(links.rowcount or 0)}

    def get_relation(self, char_id: str) -> MemoryRelation | None:
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT char_id, familiarity, trust, warmth, unresolved, "
                    "recent_conflict, updated_at FROM memory_relations WHERE char_id = ?",
                    (char_id,),
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        if row is None:
            return None
        return MemoryRelation(
            char_id=str(row[0]),
            familiarity=float(row[1]),
            trust=float(row[2]),
            warmth=float(row[3]),
            unresolved=str(row[4]),
            recent_conflict=str(row[5]),
            updated_at=float(row[6]),
        )

    def save_relation(self, relation: MemoryRelation) -> None:
        with self._lock:
            try:
                self._connection.execute(
                    "INSERT INTO memory_relations (char_id, familiarity, trust, warmth, "
                    "unresolved, recent_conflict, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(char_id) DO UPDATE SET "
                    "familiarity = excluded.familiarity, trust = excluded.trust, "
                    "warmth = excluded.warmth, unresolved = excluded.unresolved, "
                    "recent_conflict = excluded.recent_conflict, "
                    "updated_at = excluded.updated_at",
                    (
                        relation.char_id,
                        relation.familiarity,
                        relation.trust,
                        relation.warmth,
                        relation.unresolved,
                        relation.recent_conflict,
                        relation.updated_at,
                    ),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
