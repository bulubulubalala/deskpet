"""文件职责：SQLCipher 记忆库的组装类与开库入口（唯一碰连接的域是它自己的生命周期方法）。

各域的实现按 mixin 拆在同目录：messages / maintenance / character_state / memories /
periods / diary / graph / embeddings / summaries。mixin 只有 self._connection 这一个约定。"""

from __future__ import annotations

import contextlib
import threading
import time
from pathlib import Path
from typing import Any

from sqlcipher3 import dbapi2 as sqlcipher

from adapters.memory_schema import MemorySchema
from core.memory import (
    MemoryKeyInvalidError,
)

from .base import Clock, ConnectionFactory, MemoryStoreBase
from .character_state import CharacterStateMixin
from .diary import DiaryMixin
from .embeddings import EmbeddingsMixin
from .graph import GraphMixin
from .maintenance import MaintenanceMixin
from .memories import MemoriesMixin
from .messages import MessagesMixin
from .periods import PeriodsMixin
from .summaries import SummariesMixin


class MemorySqliteStore(
    MessagesMixin,
    MaintenanceMixin,
    CharacterStateMixin,
    MemoriesMixin,
    PeriodsMixin,
    DiaryMixin,
    GraphMixin,
    EmbeddingsMixin,
    SummariesMixin,
    MemoryStoreBase,
):
    """MemoryStore 的 SQLCipher 实现（唯一落盘实现）。"""

    def __init__(
        self,
        path: Path,
        *,
        key: bytes,
        connection_factory: ConnectionFactory | None = None,
        clock: Clock | None = None,
    ) -> None:
        if len(key) != 32:
            raise MemoryKeyInvalidError(f"记忆库密钥必须是 32 字节，收到 {len(key)} 字节")
        self._path = path
        self._key = key
        self._clock = clock or time.time
        self._lock = threading.RLock()
        factory = connection_factory or self._connect
        self._connection: Any = factory(str(path))
        try:
            try:
                key_literal = f"x'{key.hex()}'"
                self._connection.execute(f'PRAGMA key = "{key_literal}"')
                self._connection.execute("PRAGMA busy_timeout = 5000")
            except sqlcipher.Error as exc:  # pragma: no cover - 只在库文件被换成明文时触发
                raise MemoryKeyInvalidError(f"记忆库密钥无法应用：{exc}") from exc
            # 关键：PRAGMA key 之后必须真的读一次库，才能知道密钥对不对
            # （SQLCipher 的错配错误是在第一次读页时才报出来的）。
            try:
                self._connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
            except sqlcipher.DatabaseError as exc:
                raise MemoryKeyInvalidError("记忆库密钥与库文件不匹配，或库文件已损坏") from exc
            self._setup_pragmas()
            # 建表 / 迁移 / 迁移自检都在 adapters.memory_schema（D3）
            self._schema = MemorySchema(
                self._connection,
                self._path,
                clock=self._clock,
                translate=self._translate,
                lock=self._lock,
            )
            self._schema.ensure()
        except BaseException:
            # 构造失败必须关掉已打开的连接：Windows 上句柄没释放，调用方连
            # rename 回滚（恢复包密钥不对）都会 PermissionError。
            with contextlib.suppress(Exception):
                self.close()
            raise

    # ---- 生命周期 ---------------------------------------------------------

    def _connect(self, path: str) -> Any:
        return sqlcipher.connect(path, check_same_thread=False)

    def _setup_pragmas(self) -> None:
        for statement in (
            "PRAGMA journal_mode = WAL",
            "PRAGMA synchronous = NORMAL",
            "PRAGMA foreign_keys = ON",
        ):
            try:
                self._connection.execute(statement)
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc

    def close(self) -> None:
        """关闭连接（幂等）。"""
        # 关闭失败没有补救动作
        with self._lock, contextlib.suppress(sqlcipher.Error):
            self._connection.close()

    @property
    def path(self) -> Path:
        """库文件路径（日志与排查用）。"""
        return self._path

    def backup_to(self, path: Path) -> None:
        """把整库快照写到 path（D9 每日备份）。

        为什么用 VACUUM INTO 而不是 shutil.copy：库在 WAL 模式下写入随时发生，
        copy 主文件会漏掉 -wal 里未合并的页；VACUUM INTO 在持锁期间由 SQLite
        生成一致副本，且沿用它已解开的密钥，调用方不需要再碰一次密钥。
        """
        with self._lock:
            try:
                # 目标已存在时 VACUUM INTO 会报错：先清掉上一次的残留（半份快照不可用）
                path.unlink(missing_ok=True)
                self._connection.execute("VACUUM INTO ?", (str(path),))
            except sqlcipher.Error as exc:
                raise self._translate(exc) from exc


def open_memory_store(
    path: Path,
    *,
    key: bytes,
    connection_factory: ConnectionFactory | None = None,
    clock: Clock | None = None,
) -> MemorySqliteStore:
    """建库（含目录与表结构）并返回 store；这是服务层唯一的开库入口。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    return MemorySqliteStore(path, key=key, connection_factory=connection_factory, clock=clock)
