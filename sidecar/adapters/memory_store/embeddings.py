"""语义索引：待补向量的行、写入向量、向量检索与统计。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from core.memory import (
    EmbeddingSource,
    MemoryBackendError,
    VectorHit,
)

from .base import MemoryStoreBase
from .vectors import _cosine, _decode_vector, _encode_vector


class EmbeddingsMixin(MemoryStoreBase):
    """语义索引：待补向量的行、写入向量、向量检索与统计。"""

    def pending_embeddings(
        self, *, model_id: str, char_id: str = "", limit: int = 64
    ) -> list[EmbeddingSource]:
        """取尚未用当前模型向量化的消息、事实与时间桶；按发生时间新到旧。"""
        if limit <= 0:
            return []
        sources: list[EmbeddingSource] = []
        with self._lock:
            try:
                char_filter = " AND m.char_id = ?" if char_id else ""
                remaining = limit
                params: tuple[Any, ...] = (
                    (model_id, char_id, remaining) if char_id else (model_id, remaining)
                )
                rows = self._connection.execute(
                    "SELECT m.id, m.char_id, m.text, m.ts FROM messages m "
                    "LEFT JOIN memory_embeddings e ON e.source_type = 'message' "
                    "AND e.source_id = m.id AND e.model_id = ? "
                    "WHERE e.id IS NULL" + char_filter + " ORDER BY m.ts DESC LIMIT ?",
                    params,
                ).fetchall()
                sources.extend(
                    EmbeddingSource("message", int(row[0]), str(row[1]), str(row[2]), float(row[3]))
                    for row in rows
                )
                remaining = limit - len(sources)
                if remaining > 0:
                    params = (model_id, char_id, remaining) if char_id else (model_id, remaining)
                    rows = self._connection.execute(
                        "SELECT m.id, m.char_id, m.text, m.created_at FROM memories m "
                        "LEFT JOIN memory_embeddings e ON e.source_type = 'memory' "
                        "AND e.source_id = m.id AND e.model_id = ? "
                        "WHERE e.id IS NULL" + char_filter + " ORDER BY m.created_at DESC LIMIT ?",
                        params,
                    ).fetchall()
                    sources.extend(
                        EmbeddingSource(
                            "memory", int(row[0]), str(row[1]), str(row[2]), float(row[3])
                        )
                        for row in rows
                    )
                remaining = limit - len(sources)
                if remaining > 0:
                    period_filter = " AND p.char_id = ?" if char_id else ""
                    params = (model_id, char_id, remaining) if char_id else (model_id, remaining)
                    rows = self._connection.execute(
                        "SELECT p.id, p.char_id, p.summary, p.period_start "
                        "FROM memory_periods p LEFT JOIN memory_embeddings e "
                        "ON e.source_type = 'period' AND e.source_id = p.id "
                        "AND e.model_id = ? WHERE e.id IS NULL"
                        + period_filter
                        + " ORDER BY p.period_start DESC LIMIT ?",
                        params,
                    ).fetchall()
                    sources.extend(
                        EmbeddingSource(
                            "period", int(row[0]), str(row[1]), str(row[2]), float(row[3])
                        )
                        for row in rows
                    )
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return sources

    def upsert_embedding(
        self,
        source: EmbeddingSource,
        vector: Sequence[float],
        *,
        model_id: str,
        now: float,
    ) -> None:
        """写入/更新一条向量；同一 source + model 只保留一行。"""
        if not vector:
            raise MemoryBackendError("不能写入空 embedding")
        with self._lock:
            try:
                self._connection.execute(
                    "INSERT INTO memory_embeddings (source_type, source_id, char_id, text, "
                    "embedding, dim, model_id, source_ts, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(source_type, source_id, model_id) DO UPDATE SET "
                    "text = excluded.text, embedding = excluded.embedding, dim = excluded.dim, "
                    "char_id = excluded.char_id, source_ts = excluded.source_ts, "
                    "updated_at = excluded.updated_at",
                    (
                        source.source_type,
                        source.source_id,
                        source.char_id,
                        source.text,
                        _encode_vector(vector),
                        len(vector),
                        model_id,
                        source.occurred_at,
                        float(now),
                        float(now),
                    ),
                )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc

    def search_embeddings(
        self,
        query_vector: Sequence[float],
        *,
        char_id: str,
        model_id: str,
        limit: int,
        source_types: Sequence[str] = ("memory",),
        min_score: float = 0.0,
    ) -> list[VectorHit]:
        """按余弦相似度检索；维度不一致或低于阈值的直接跳过。"""
        if limit <= 0 or not query_vector or not source_types:
            return []
        placeholders = ",".join("?" for _ in source_types)
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT e.source_type, e.source_id, e.char_id, e.text, e.embedding, "
                    "e.source_ts, COALESCE(m.kind, ''), COALESCE(m.importance, 0.0) "
                    "FROM memory_embeddings e "
                    "LEFT JOIN memories m ON e.source_type = 'memory' AND m.id = e.source_id "
                    "WHERE e.char_id = ? AND e.model_id = ? "
                    f"AND e.source_type IN ({placeholders})",
                    (char_id, model_id, *source_types),
                ).fetchall()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        hits: list[VectorHit] = []
        for row in rows:
            vector = _decode_vector(row[4])
            score = _cosine(query_vector, vector)
            if score < min_score:
                continue
            hits.append(
                VectorHit(
                    source_type=str(row[0]),
                    source_id=int(row[1]),
                    char_id=str(row[2]),
                    text=str(row[3]),
                    score=score,
                    occurred_at=float(row[5] or 0.0),
                    kind=str(row[6] or ""),
                    importance=float(row[7] or 0.0),
                )
            )
        hits.sort(key=lambda item: item.score, reverse=True)
        return hits[:limit]

    def embedding_counts(self, *, model_id: str, char_id: str = "") -> tuple[int, int]:
        """返回（已索引数，待索引数）。"""
        char_filter = " AND char_id = ?" if char_id else ""
        message_filter = " AND m.char_id = ?" if char_id else ""
        period_filter = " AND p.char_id = ?" if char_id else ""
        with self._lock:
            try:
                indexed_params: tuple[Any, ...] = (model_id, char_id) if char_id else (model_id,)
                indexed = int(
                    self._connection.execute(
                        "SELECT count(*) FROM memory_embeddings WHERE model_id = ?" + char_filter,
                        indexed_params,
                    ).fetchone()[0]
                )
                pending_messages = int(
                    self._connection.execute(
                        "SELECT count(*) FROM messages m LEFT JOIN memory_embeddings e "
                        "ON e.source_type = 'message' AND e.source_id = m.id AND e.model_id = ? "
                        "WHERE e.id IS NULL" + message_filter,
                        indexed_params,
                    ).fetchone()[0]
                )
                pending_memories = int(
                    self._connection.execute(
                        "SELECT count(*) FROM memories m LEFT JOIN memory_embeddings e "
                        "ON e.source_type = 'memory' AND e.source_id = m.id AND e.model_id = ? "
                        "WHERE e.id IS NULL" + message_filter,
                        indexed_params,
                    ).fetchone()[0]
                )
                pending_periods = int(
                    self._connection.execute(
                        "SELECT count(*) FROM memory_periods p LEFT JOIN memory_embeddings e "
                        "ON e.source_type = 'period' AND e.source_id = p.id AND e.model_id = ? "
                        "WHERE e.id IS NULL" + period_filter,
                        indexed_params,
                    ).fetchone()[0]
                )
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return indexed, pending_messages + pending_memories + pending_periods

    def clear_embeddings(self, *, char_id: str = "", model_id: str = "") -> int:
        """清空指定角色/模型的向量；角色完全重置时用。"""
        clauses: list[str] = []
        params: list[Any] = []
        if char_id:
            clauses.append("char_id = ?")
            params.append(char_id)
        if model_id:
            clauses.append("model_id = ?")
            params.append(model_id)
        sql = "DELETE FROM memory_embeddings"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        with self._lock:
            try:
                cursor = self._connection.execute(sql, tuple(params))
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        return int(cursor.rowcount or 0)
