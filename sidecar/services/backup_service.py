"""记忆库每日快照（D9）：启动补一次，之后每小时看一次是否跨天。

为什么不是"复制 memories.db 文件"：库是 SQLCipher + WAL，直接 copy 可能拿到半个事务
（-wal 里还有没并进主库的页）；快照统一走 VACUUM INTO——由 SQLite 自己产出一致性副本，
不需要停写入，也不需要第二份密钥。密钥只有 SqliteMemoryStore 有，所以真正落盘的动作
在 store.backup_to()，本服务只负责"什么时候备份、放哪里、留几份"。

失败不抛：备份是尽力而为的后台任务，坏一次不能拖垮引擎启动。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from contracts.data import BackupKind
from core.logging import get_logger, log_event

LOGGER = get_logger("services.backup_service")

DEFAULT_KEEP = 7
#: 每小时醒一次：跨天那一刻错过也没关系，最晚一小时内补上
DEFAULT_INTERVAL_S = 3600.0
FILE_PREFIX = "memories-"
FILE_SUFFIX = ".db"
#: 破坏性操作前留底的文件名前缀，与每日快照区分开（清理时两套各留各的份数）
SNAPSHOT_PREFIX = "memories-before-"
#: 同一个操作留最近几份就够：这类快照是「刚刚手滑」时的后悔药，不是长期归档
SNAPSHOT_KEEP = 3
#: 恢复流程留下的残骸（被替换的旧库 / 换了密钥打不开的新库），给界面区分用
REPLACED_PREFIX = "memories-replaced-"
REJECTED_PREFIX = "memories-rejected-"
#: 每日快照的文件名形状：memories-YYYYMMDD.db，别把留底混进来
_DAILY_PATTERN = re.compile(r"memories-\d{8}\.db")


@dataclass(frozen=True)
class BackupEntry:
    """备份目录里的一个文件；kind 只用于界面分组，不影响任何清理逻辑。"""

    file: str
    kind: BackupKind
    bytes: int
    modified_at: float


class BackupTarget(Protocol):
    """能对自己做一致性快照的记忆库（实现方是 adapters.memory_sqlite）。"""

    def backup_to(self, path: Path) -> None:
        """把整库快照写到 path；path 必须不存在。"""
        ...


class MemoryBackupService:
    def __init__(
        self,
        store: BackupTarget | None,
        backup_dir: Path,
        *,
        keep: int = DEFAULT_KEEP,
        interval_s: float = DEFAULT_INTERVAL_S,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._backup_dir = backup_dir
        self._keep = max(1, keep)
        self._interval_s = interval_s
        self._now = now

    async def run_once(self) -> Path | None:
        """当天还没有快照就做一份；已有则只按保留份数清理。返回新快照路径，没做返回 None。"""
        if self._store is None:
            return None
        target = self._file_for(self._day_key())
        if target.exists() and target.stat().st_size > 0:
            self._prune()
            return None
        temp = target.with_suffix(".tmp")
        try:
            await asyncio.to_thread(self._write, temp)
        except Exception as exc:
            temp.unlink(missing_ok=True)
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.backup",
                event="memory.backup_failed",
                message="记忆库快照失败，本轮跳过",
                fields={"error": type(exc).__name__, "detail": str(exc)},
            )
            return None
        temp.replace(target)
        deleted = self._prune()
        log_event(
            LOGGER,
            logging.INFO,
            module="services.backup",
            event="memory.backup",
            message="记忆库快照完成",
            fields={"file": target.name, "size": target.stat().st_size, "pruned": deleted},
        )
        return target

    async def snapshot_before(self, reason: str) -> Path | None:
        """破坏性操作前立刻留一份（D9 第 5 条）：清空记忆、恢复数据包之类。

        与每日快照共用 VACUUM INTO，但文件名单列一套（memories-before-<原因>-<时间>），
        保留份数也分开算——否则一次误操作后的后悔药会把每日快照挤掉。
        失败只记日志、返回 None：留底做不成时由调用方决定是否继续，不在这里替它决定。
        """
        if self._store is None:
            return None
        slug = self._slug(reason)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self._now()))
        target = self._backup_dir / f"{SNAPSHOT_PREFIX}{slug}-{stamp}{FILE_SUFFIX}"
        temp = target.with_suffix(".tmp")
        try:
            await asyncio.to_thread(self._write, temp)
        except Exception as exc:
            temp.unlink(missing_ok=True)
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.backup",
                event="memory.snapshot_failed",
                message="操作前留底失败",
                fields={"reason": slug, "error": type(exc).__name__, "detail": str(exc)},
            )
            return None
        temp.replace(target)
        deleted = self._prune_snapshots(slug)
        log_event(
            LOGGER,
            logging.INFO,
            module="services.backup",
            event="memory.snapshot_before",
            message="破坏性操作前已留底",
            fields={
                "reason": slug,
                "file": target.name,
                "size": target.stat().st_size,
                "pruned": deleted,
            },
        )
        return target

    async def snapshot_now(self) -> Path | None:
        """用户点「立即备份」：与操作前留底同一条路径（VACUUM INTO），原因固定 manual。"""
        return await self.snapshot_before("manual")

    def list_files(self) -> list[BackupEntry]:
        """列出备份目录里的可用文件（按修改时间新→旧）；读不到目录时给空表，不抛。"""
        try:
            paths = list(self._backup_dir.glob(f"*{FILE_SUFFIX}"))
        except OSError:
            return []
        entries: list[BackupEntry] = []
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                continue
            if not path.is_file() or stat.st_size <= 0:
                continue
            entries.append(
                BackupEntry(
                    file=path.name,
                    kind=self._kind_of(path.name),
                    bytes=stat.st_size,
                    modified_at=stat.st_mtime,
                )
            )
        entries.sort(key=lambda entry: (-entry.modified_at, entry.file))
        return entries

    @property
    def backup_dir(self) -> Path:
        return self._backup_dir

    async def run_forever(self) -> None:
        if self._store is None:
            return
        while True:
            await self.run_once()
            await asyncio.sleep(self._interval_s)

    # ---- 内部 --------------------------------------------------------------

    def _write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # VACUUM INTO 要求目标不存在；上一次崩溃可能留下半份 tmp
        path.unlink(missing_ok=True)
        if self._store is not None:
            self._store.backup_to(path)

    def _day_key(self) -> str:
        return time.strftime("%Y%m%d", time.localtime(self._now()))

    def _file_for(self, day: str) -> Path:
        return self._backup_dir / f"{FILE_PREFIX}{day}{FILE_SUFFIX}"

    @staticmethod
    def _kind_of(name: str) -> BackupKind:
        """按文件名判类型；认不出来的一律 other（界面只显示、不据此做任何删除）。"""
        if name.startswith(SNAPSHOT_PREFIX):
            return "before"
        if name.startswith(REPLACED_PREFIX):
            return "replaced"
        if name.startswith(REJECTED_PREFIX):
            return "rejected"
        if _DAILY_PATTERN.fullmatch(name):
            return "daily"
        return "other"

    @staticmethod
    def _slug(reason: str) -> str:
        """原因串只留小写字母数字与连字符，别让文件名带路径分隔符。"""
        cleaned = re.sub(r"[^a-z0-9]+", "-", reason.lower()).strip("-")
        return cleaned or "op"

    def _prune_snapshots(self, slug: str) -> int:
        """同一个原因的留底只留最近 SNAPSHOT_KEEP 份，别的原因的不动。"""
        try:
            files = sorted(self._backup_dir.glob(f"{SNAPSHOT_PREFIX}{slug}-*{FILE_SUFFIX}"))
        except OSError:
            return 0
        deleted = 0
        for stale in files[: max(0, len(files) - SNAPSHOT_KEEP)]:
            try:
                stale.unlink()
                deleted += 1
            except OSError as exc:
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="services.backup",
                    event="memory.backup_prune_failed",
                    message="旧留底删不掉",
                    fields={"file": stale.name, "detail": str(exc)},
                )
        return deleted

    def _prune(self) -> int:
        """只留最近 keep 份每日快照：按文件名里的日期排序（同一天不会有第二份），不依赖 mtime。

        只匹配 memories-YYYYMMDD.db 这种形状：留底文件（memories-before-*）与替换残骸
        （memories-replaced-*）不该被每日清理顺手删掉。
        """
        try:
            files = sorted(
                self._backup_dir.glob(
                    f"{FILE_PREFIX}[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]{FILE_SUFFIX}"
                )
            )
        except OSError:
            return 0
        deleted = 0
        for stale in files[: max(0, len(files) - self._keep)]:
            try:
                stale.unlink()
                deleted += 1
            except OSError as exc:
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="services.backup",
                    event="memory.backup_prune_failed",
                    message="旧快照删不掉",
                    fields={"file": stale.name, "detail": str(exc)},
                )
        return deleted
