"""过期清理：按保留期与「永久重要」判定裁掉老消息、摘要、周期。"""

from __future__ import annotations

from sqlcipher3 import dbapi2 as sqlcipher

from .base import MemoryStoreBase


class MaintenanceMixin(MemoryStoreBase):
    """过期清理：按保留期与「永久重要」判定裁掉老消息、摘要、周期。"""

    def purge_expired(self, *, cutoff: float, permanent_importance: float) -> dict[str, int]:
        """删除已成功压缩/聚合且超过保留期的原文与摘要，以及低重要度事实。"""
        with self._lock:
            try:
                message_ids = [
                    int(row[0])
                    for row in self._connection.execute(
                        "SELECT m.id FROM messages m JOIN summaries s ON s.id = m.covered_by "
                        "WHERE s.created_at < ?",
                        (cutoff,),
                    ).fetchall()
                ]
                self._drop_embeddings("message", message_ids)
                for message_id in message_ids:
                    self._connection.execute(
                        "DELETE FROM messages_fts WHERE rowid = ?", (message_id,)
                    )
                if message_ids:
                    self._connection.execute(
                        "DELETE FROM messages WHERE id IN ("
                        + ",".join("?" for _ in message_ids)
                        + ")",
                        tuple(message_ids),
                    )
                summary_ids = [
                    int(row[0])
                    for row in self._connection.execute(
                        "SELECT id FROM summaries WHERE archived_at > 0 AND archived_at < ?",
                        (cutoff,),
                    ).fetchall()
                ]
                if summary_ids:
                    self._connection.execute(
                        "DELETE FROM summaries WHERE id IN ("
                        + ",".join("?" for _ in summary_ids)
                        + ")",
                        tuple(summary_ids),
                    )
                self._connection.commit()
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc
        if message_ids or summary_ids:
            self._vacuum()
        return {
            "messages": len(message_ids),
            "summaries": len(summary_ids),
            # 事实不再硬删：由 decay_memories 标 dormant / archived。
            "memories": 0,
        }
