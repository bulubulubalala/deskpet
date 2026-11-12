"""L2 时间线：时间段的存取、来源关联、衰减与修改。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    DEFAULT_TIMELINE_LIMIT,
    MemoryBackendError,
    MemoryPeriod,
    to_fts_body,
    to_fts_query,
)

from .base import MemoryStoreBase
from .rows import _to_period


class PeriodsMixin(MemoryStoreBase):
    """L2 时间线：时间段的存取、来源关联、衰减与修改。"""

    def list_periods(
        self,
        char_id: str,
        *,
        levels: Sequence[str] = (),
        limit: int = DEFAULT_TIMELINE_LIMIT,
        since: float = 0.0,
        until: float = 0.0,
    ) -> list[MemoryPeriod]:
        """按 period_start 倒序列出时间桶；levels 留空表示全部层级。"""
        if limit <= 0:
            return []
        clauses = ["char_id = ?", "state != 'archived'"]
        params: list[Any] = [char_id]
        if levels:
            clauses.append("level IN (" + ",".join("?" for _ in levels) + ")")
            params.extend(levels)
        if since > 0:
            clauses.append("period_end >= ?")
            params.append(since)
        if until > 0:
            clauses.append("period_start < ?")
            params.append(until)
        params.append(max(1, limit))
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, char_id, level, period_start, period_end, day_key, label, "
                    "summary, source_hash, model_id, edited_at, created_at, updated_at, "
                    "archived_at, strength, state, pinned "
                    "FROM memory_periods WHERE "
                    + " AND ".join(clauses)
                    + " ORDER BY period_start DESC, id DESC LIMIT ?",
                    tuple(params),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_period(row) for row in rows]

    def search_periods(
        self,
        char_id: str,
        *,
        query: str,
        limit: int = DEFAULT_TIMELINE_LIMIT,
        levels: Sequence[str] = (),
    ) -> list[MemoryPeriod]:
        match = to_fts_query(query)
        if not match or limit <= 0:
            return []
        clauses = ["memory_periods_fts MATCH ?", "p.char_id = ?", "p.state != 'archived'"]
        params: list[Any] = [match, char_id]
        if levels:
            clauses.append("p.level IN (" + ",".join("?" for _ in levels) + ")")
            params.extend(levels)
        params.append(max(1, limit))
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT p.id, p.char_id, p.level, p.period_start, p.period_end, "
                    "p.day_key, p.label, p.summary, p.source_hash, p.model_id, p.edited_at, "
                    "p.created_at, p.updated_at, p.archived_at, p.strength, p.state, p.pinned "
                    "FROM memory_periods_fts JOIN memory_periods p "
                    "ON p.id = memory_periods_fts.rowid WHERE "
                    + " AND ".join(clauses)
                    + " ORDER BY bm25(memory_periods_fts) LIMIT ?",
                    tuple(params),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [_to_period(row) for row in rows]

    def get_period(self, period_id: int) -> MemoryPeriod | None:
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT id, char_id, level, period_start, period_end, day_key, label, "
                    "summary, source_hash, model_id, edited_at, created_at, updated_at, "
                    "archived_at, strength, state, pinned FROM memory_periods WHERE id = ?",
                    (period_id,),
                ).fetchone()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return None if row is None else _to_period(row)

    def upsert_period(
        self,
        *,
        char_id: str,
        level: str,
        period_start: float,
        period_end: float,
        summary: str,
        label: str = "",
        day_key: str = "",
        source_hash: str = "",
        model_id: str = "",
        sources: Sequence[tuple[str, int]] = (),
        now: float = 0.0,
        force: bool = False,
    ) -> int:
        """写入/更新时间桶；手动编辑过的桶默认不覆盖，除非 force=True。"""
        moment = float(now or self._clock())
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT id, edited_at FROM memory_periods "
                    "WHERE char_id = ? AND level = ? AND period_start = ?",
                    (char_id, level, float(period_start)),
                ).fetchone()
                if row is not None:
                    period_id = int(row[0])
                    if float(row[1] or 0.0) > 0.0 and not force:
                        return period_id
                    self._connection.execute(
                        "UPDATE memory_periods SET period_end = ?, day_key = ?, label = ?, "
                        "summary = ?, source_hash = ?, model_id = ?, updated_at = ?, "
                        "archived_at = 0 WHERE id = ?",
                        (
                            float(period_end),
                            day_key,
                            label,
                            summary,
                            source_hash,
                            model_id,
                            moment,
                            period_id,
                        ),
                    )
                    self._connection.execute(
                        "DELETE FROM memory_period_sources WHERE period_id = ?", (period_id,)
                    )
                else:
                    cursor = self._connection.execute(
                        "INSERT INTO memory_periods (char_id, level, period_start, period_end, "
                        "day_key, label, summary, source_hash, model_id, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            char_id,
                            level,
                            float(period_start),
                            float(period_end),
                            day_key,
                            label,
                            summary,
                            source_hash,
                            model_id,
                            moment,
                            moment,
                        ),
                    )
                    period_id = int(cursor.lastrowid or 0)
                fts = self._connection.execute(
                    "UPDATE memory_periods_fts SET body = ? WHERE rowid = ?",
                    (to_fts_body(summary + " " + label), period_id),
                )
                if not fts.rowcount:
                    self._connection.execute(
                        "INSERT INTO memory_periods_fts (rowid, body) VALUES (?, ?)",
                        (period_id, to_fts_body(summary + " " + label)),
                    )
                if sources:
                    self._connection.executemany(
                        "INSERT OR IGNORE INTO memory_period_sources "
                        "(period_id, source_type, source_id) VALUES (?, ?, ?)",
                        [(period_id, kind, int(source_id)) for kind, source_id in sources],
                    )
                self._drop_embeddings("period", [period_id])
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return period_id

    def period_sources(self, period_id: int) -> list[tuple[str, int]]:
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT source_type, source_id FROM memory_period_sources "
                    "WHERE period_id = ? ORDER BY source_type, source_id",
                    (period_id,),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return [(str(row[0]), int(row[1])) for row in rows]

    def decay_memories(
        self, *, now: float, dormant_days: float = 30.0, archive_days: float = 365.0
    ) -> dict[str, int]:
        """事实的软遗忘：强度随时间衰减，被用过会强化；低强度休眠，更久归档。"""
        counts = {"dormant": 0, "archived": 0, "revived": 0}
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, importance, confidence, used_count, occurred_at, "
                    "state, pinned FROM memories"
                ).fetchall()
                for row in rows:
                    memory_id = int(row[0])
                    age_days = max(0.0, now - float(row[4] or now)) / 86400.0
                    importance = float(row[1] or 0.0)
                    confidence = float(row[2] or 0.7)
                    reinforcement = 1.0 + min(int(row[3] or 0), 20) * 0.05
                    strength = min(
                        1.0,
                        importance
                        * (0.5 + confidence * 0.5)
                        * reinforcement
                        * (0.5 ** (age_days / 30.0)),
                    )
                    pinned = int(row[6] or 0) > 0
                    current = str(row[5] or "active")
                    if pinned:
                        state = "active"
                    elif age_days >= archive_days and strength < 0.15:
                        state = "archived"
                    elif age_days >= dormant_days and strength < 0.3:
                        state = "dormant"
                    else:
                        state = "active"
                    self._connection.execute(
                        "UPDATE memories SET strength = ?, state = ? WHERE id = ?",
                        (strength, state, memory_id),
                    )
                    if state != current:
                        if state == "archived":
                            counts["archived"] += 1
                        elif state == "dormant":
                            counts["dormant"] += 1
                        else:
                            counts["revived"] += 1
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return counts

    def decay_periods(
        self, *, now: float, dormant_days: float = 30.0, archive_days: float = 180.0
    ) -> dict[str, int]:
        """时间桶的软遗忘：低强度 → dormant，更久 → archived；置顶永不休眠。"""
        base_by_level = {"episode": 0.35, "day": 0.5, "week": 0.7, "month": 0.85}
        counts = {"dormant": 0, "archived": 0, "revived": 0}
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT id, level, period_end, state, pinned FROM memory_periods"
                ).fetchall()
                for row in rows:
                    period_id = int(row[0])
                    level = str(row[1])
                    age_days = max(0.0, now - float(row[2])) / 86400.0
                    base = base_by_level.get(level, 0.5)
                    strength = base * (0.5 ** (age_days / 30.0))
                    pinned = int(row[4] or 0) > 0
                    current = str(row[3] or "active")
                    if pinned:
                        state = "active"
                    elif age_days >= archive_days and strength < 0.15:
                        state = "archived"
                    elif age_days >= dormant_days and strength < 0.3:
                        state = "dormant"
                    else:
                        state = "active"
                    self._connection.execute(
                        "UPDATE memory_periods SET strength = ?, state = ? WHERE id = ?",
                        (strength, state, period_id),
                    )
                    if state != current:
                        if state == "archived":
                            counts["archived"] += 1
                        elif state == "dormant":
                            counts["dormant"] += 1
                        else:
                            counts["revived"] += 1
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return counts

    def update_period(
        self,
        period_id: int,
        *,
        summary: str,
        label: str | None = None,
        pinned: bool | None = None,
        now: float = 0.0,
    ) -> MemoryPeriod | None:
        body = summary.strip()
        if not body:
            raise MemoryBackendError("时间桶正文不能为空")
        moment = float(now or self._clock())
        with self._lock:
            try:
                row = self._connection.execute(
                    "SELECT label, pinned FROM memory_periods WHERE id = ?", (period_id,)
                ).fetchone()
                if row is None:
                    return None
                next_label = str(row[0]) if label is None else label
                next_pinned = int(row[1] or 0) if pinned is None else int(pinned)
                self._connection.execute(
                    "UPDATE memory_periods SET summary = ?, label = ?, pinned = ?, "
                    "edited_at = ?, updated_at = ?, state = 'active' WHERE id = ?",
                    (body, next_label, next_pinned, moment, moment, period_id),
                )
                self._connection.execute(
                    "UPDATE memory_periods_fts SET body = ? WHERE rowid = ?",
                    (to_fts_body(body + " " + next_label), period_id),
                )
                self._drop_embeddings("period", [period_id])
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return self.get_period(period_id)

    def delete_period(self, period_id: int) -> bool:
        with self._lock:
            try:
                self._connection.execute(
                    "DELETE FROM memory_period_sources WHERE period_id = ?", (period_id,)
                )
                cursor = self._connection.execute(
                    "DELETE FROM memory_periods WHERE id = ?", (period_id,)
                )
                self._connection.execute(
                    "DELETE FROM memory_periods_fts WHERE rowid = ?", (period_id,)
                )
                self._drop_embeddings("period", [period_id])
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return bool(cursor.rowcount)
