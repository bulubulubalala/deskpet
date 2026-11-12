"""从导出包恢复记忆库（D9 第 3 条 / M3）：先暂存，重启引擎时生效。

为什么不直接在线替换：memories.db 是 SQLCipher + WAL，当前进程正握着连接与密钥，
换文件等于把人家脚下的地板抽走（换完旧连接仍写旧 inode，改动全部丢失）。
所以分两步：
1. stage()：校验 zip、把包里的 memories.db 解到 <数据目录>/restore-pending/，此时还没动线上库；
2. apply_pending_restore()：下次 sidecar 启动、建 MemoryService 之前执行——先把现有库挪进
   backups/ 留底，再把暂存的库换上去；换完用当前密钥试开一次，开不了（换了机器、密钥不对、
   文件损坏）就回滚到刚才的留底，老库照常能读。

两条原则：
1. 永不丢数据：替换前一定先留底，回滚路径有测试覆盖。
2. 失败要说人话：不像数据包的文件直接拒绝，且不动任何现有文件。
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from adapters.memory_sqlite import open_memory_store
from config import BACKUP_DIR_NAME, Settings
from contracts.errors import CODE_MEM_RESTORE_INVALID
from core.errors import MemoryRestoreError
from core.logging import get_logger, log_event

LOGGER = get_logger("services.restore_service")

#: 暂存目录名（<数据目录>/restore-pending）
PENDING_DIR_NAME = "restore-pending"
#: 导出包里记忆库的成员名（见 services/export_service.py）
MEMBER_NAME = "memories.db"
#: 暂存文件名：与最终文件名一致，替换时只需一次 rename
PENDING_DB_NAME = "memories.db"
#: 记忆库解压上限：导出包体积与库同量级，超过这个数多半不是我们的包（也防 zip 炸弹）
MAX_DB_BYTES = 8 * 1024 * 1024 * 1024


def restore_invalid(message: str) -> MemoryRestoreError:
    """恢复包不可用：消息本身就是给用户看的说明，所以 message 与 user_hint 用同一句。"""
    return MemoryRestoreError(CODE_MEM_RESTORE_INVALID, message, user_hint=message)


@dataclass(frozen=True, slots=True)
class RestoreStage:
    """一次「暂存成功」的结果；字段与 contracts/data.py 的响应模型一一对应。"""

    archive: Path
    db_bytes: int
    pending_path: Path
    entries: tuple[str, ...] = ()


def pending_db_file(data_dir: Path) -> Path:
    """暂存位置的唯一算法：读取方（组合根）与写入方（本服务）都用它，避免两处拼路径。"""
    return data_dir / PENDING_DIR_NAME / PENDING_DB_NAME


class DataRestoreService:
    """把导出包里的记忆库解到暂存目录；真正的替换在下次启动时做（见 apply_pending_restore）。"""

    def __init__(self, settings: Settings, *, data_dir: Path | None = None) -> None:
        self._settings = settings
        self._data_dir = data_dir if data_dir is not None else settings.data_dir

    async def stage(self, archive: Path) -> RestoreStage:
        """解压到暂存目录；解压是磁盘活，放线程池里跑，别堵事件循环。"""
        return await asyncio.to_thread(self._stage_sync, archive)

    def _stage_sync(self, archive: Path) -> RestoreStage:
        if not archive.is_file():
            raise restore_invalid(f"找不到数据包：{archive}")
        try:
            with zipfile.ZipFile(archive) as zf:
                names = zf.namelist()
                if MEMBER_NAME not in names:
                    raise restore_invalid(
                        f"这个压缩包里没有 {MEMBER_NAME}，不是 deskpet 导出的数据包。"
                    )
                info = zf.getinfo(MEMBER_NAME)
                if info.file_size <= 0:
                    raise restore_invalid(f"包里的 {MEMBER_NAME} 是空文件，恢复不了。")
                if info.file_size > MAX_DB_BYTES:
                    raise restore_invalid(
                        f"包里的 {MEMBER_NAME} 大得不正常（{info.file_size} 字节）。"
                    )
                pending = pending_db_file(self._data_dir)
                pending.parent.mkdir(parents=True, exist_ok=True)
                temp = pending.with_name(PENDING_DB_NAME + ".tmp")
                try:
                    with zf.open(MEMBER_NAME) as src, temp.open("wb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
                    temp.replace(pending)
                except BaseException:
                    temp.unlink(missing_ok=True)
                    raise
        except zipfile.BadZipFile as exc:
            raise restore_invalid(f"这个文件不是 zip 压缩包：{archive.name}") from exc
        return RestoreStage(
            archive=archive,
            db_bytes=pending.stat().st_size,
            pending_path=pending,
            entries=tuple(names),
        )


def apply_pending_restore(
    settings: Settings,
    *,
    key: bytes,
    now: Callable[[], float] = time.time,
) -> Path | None:
    """把暂存的库换上去（组合根在建 MemoryService 之前调用）；返回替换后的库路径。

    没有暂存文件时什么都不做（返回 None）。换上去之后立刻用当前密钥试开一次：
    开不了说明这份包不属于这台机器（密钥不同）或文件坏了——把残骸挪进 backups/ 并回滚。
    """
    pending = pending_db_file(settings.data_dir)
    if not pending.exists():
        return None
    db_file = settings.memory_db_file
    backup_dir = settings.data_dir / BACKUP_DIR_NAME
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now()))
    replaced = backup_dir / f"memories-replaced-{stamp}.db"
    had_current = db_file.exists()
    if had_current:
        db_file.replace(replaced)
    for suffix in ("-wal", "-shm"):
        Path(f"{db_file}{suffix}").unlink(missing_ok=True)
    pending.replace(db_file)
    try:
        opened = open_memory_store(db_file, key=key)
    # 任何打不开的原因（密钥不同、文件损坏、SQLCipher 版本不符）都走同一条回滚路径
    except Exception as exc:
        db_file.replace(backup_dir / f"memories-rejected-{stamp}.db")
        if had_current:
            replaced.replace(db_file)
        log_event(
            LOGGER,
            logging.ERROR,
            module="services.restore_service",
            event="memory.restore_rejected",
            message="恢复包打不开（密钥不同或文件损坏），已回滚到原来的记忆库",
            fields={"reason": type(exc).__name__, "error": str(exc)},
        )
        return None
    opened.close()
    log_event(
        LOGGER,
        logging.INFO,
        module="services.restore_service",
        event="memory.restore_applied",
        message="已用恢复包替换记忆库",
        fields={"db": str(db_file), "backup": str(replaced) if had_current else ""},
    )
    return db_file
