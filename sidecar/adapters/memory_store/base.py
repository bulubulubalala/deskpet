"""文件职责：记忆库实现的公共底座——连接/锁/时钟的声明，以及错误翻译、压缩、向量清理这类
被多个域共用的小动作（不碰具体业务 SQL）。"""

from __future__ import annotations

import contextlib
import sqlite3
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from adapters.memory_schema import MemorySchema
from core.memory import (
    MemoryBackendError,
    MemoryIndexBrokenError,
    MemoryReadonlyError,
    MessageRow,
)

ConnectionFactory = Callable[[str], Any]
Clock = Callable[[], float]


class MemoryStoreBase:
    """所有域 mixin 的基类：只声明共享状态，不放业务方法。"""

    _path: Path
    _key: bytes
    _clock: Clock
    _lock: Any
    _connection: Any
    _schema: MemorySchema

    def _translate(self, exc: sqlite3.Error) -> MemoryBackendError:
        """把 sqlite 的报错翻译成服务层能映射成 DP-MEM-* 的异常。"""
        message = str(exc).lower()
        readonly_markers = ("readonly", "unable to open database file", "attempt to write")
        if any(marker in message for marker in readonly_markers):
            return MemoryReadonlyError(f"记忆库不可写：{exc}")
        if "fts5" in message or "no such module" in message or "malformed" in message:
            return MemoryIndexBrokenError(f"记忆库全文索引不可用：{exc}")
        return MemoryBackendError(f"记忆库操作失败：{exc}")

    def _vacuum(self) -> None:
        with self._lock, contextlib.suppress(sqlcipher.Error):
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._connection.execute("VACUUM")

    def _drop_embeddings(self, source_type: str, source_ids: Sequence[int]) -> None:
        if not source_ids:
            return
        placeholders = ",".join("?" for _ in source_ids)
        self._connection.execute(
            "DELETE FROM memory_embeddings WHERE source_type = ? "
            f"AND source_id IN ({placeholders})",
            (source_type, *source_ids),
        )

    @staticmethod
    def _message_row(row: Sequence[Any]) -> MessageRow:
        """把一行 messages 记录映射成 MessageRow（两处查询共用，列顺序一致）。"""
        return MessageRow(
            message_id=int(row[0]),
            char_id=str(row[1]),
            session_id=str(row[2]),
            role=str(row[3]),
            text=str(row[4]),
            ts=float(row[5]),
            token_len=int(row[6]),
            covered_by=int(row[7]),
        )
