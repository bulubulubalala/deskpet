"""数据导出（D9 / M3）：把「换机器要带走的东西」打成一个 zip。

为什么导出放在 sidecar：要带走的核心是 memories.db，而它是 SQLCipher + WAL——
直接拷文件可能拿到半个事务（-wal 里还有没并进主库的页），密钥也只有 sidecar 解得出。
所以这里先走 store.backup_to()（VACUUM INTO）拿一致性快照，再把「设置 + 角色 + 日志摘要」
一起打包。

两条原则：
1. 绝不打真实密钥：设置里的 api_key / token / secret 统一替换成占位符，文档里写明「换机器要重填」。
2. 缺什么写清楚：记忆库没打开、日志不存在、单个角色文件过大，都记进 skipped 而不是静默跳过。
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import re
import sqlite3
import time
import zipfile
from collections.abc import Callable, Iterable
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from config import Settings
from core.logging import get_logger, log_event

LOGGER = get_logger("services.export_service")

REPO_ROOT = Path(__file__).resolve().parents[2]

#: 导出目录名（<数据目录>/exports）
EXPORTS_DIR_NAME = "exports"
FILE_PREFIX = "deskpet-export-"
FILE_SUFFIX = ".zip"
#: 只留最近几份：导出包体积和记忆库同量级，留太多会悄悄吃掉磁盘
DEFAULT_KEEP = 3
#: 日志只带尾部：排查一次故障通常几十行就够
DEFAULT_LOG_LINES = 300
#: 单个角色文件上限：Live2D 模型一般几 MB，超过这个数多半是用户误放的大文件
MAX_CHARACTER_FILE_BYTES = 200 * 1024 * 1024

_MASKED = "***（已脱敏）"
_SECRET_KEY = re.compile(r"(api_key|token|secret|password|cookie)", re.IGNORECASE)


class BackupTarget(Protocol):
    """能对自己做一致性快照的记忆库（实现方是 adapters.memory_sqlite）。"""

    def backup_to(self, path: Path) -> None: ...


@dataclass(frozen=True, slots=True)
class ExportResult:
    """一次导出的结果；字段与 contracts/data.py 的响应模型一一对应。"""

    path: Path
    size_bytes: int
    created_at: str
    entries: tuple[str, ...] = ()
    skipped: tuple[str, ...] = field(default_factory=tuple)


def mask_settings(value: Any, key: str = "") -> Any:
    """把设置树里的密钥替换成占位符（导出包可能被发到聊天窗口里）。"""
    if isinstance(value, dict):
        return {name: mask_settings(item, name) for name, item in value.items()}
    if isinstance(value, list | tuple):
        return [mask_settings(item, key) for item in value]
    if _SECRET_KEY.search(key) and str(value).strip():
        return _MASKED
    if isinstance(value, Path):
        return str(value)
    return value


class DataExportService:
    """把数据目录里的可迁移内容打成一个 zip；一次只允许一个导出在跑。"""

    def __init__(
        self,
        settings: Settings,
        store: BackupTarget | None = None,
        *,
        exports_dir: Path | None = None,
        keep: int = DEFAULT_KEEP,
        log_lines: int = DEFAULT_LOG_LINES,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._settings = settings
        self._store = store
        self._exports_dir = exports_dir or settings.data_dir / EXPORTS_DIR_NAME
        self._keep = max(1, keep)
        self._log_lines = max(0, log_lines)
        self._now = now
        self._lock = asyncio.Lock()

    async def export(self) -> ExportResult:
        """打包一次；阻塞的部分（VACUUM INTO、压缩）放线程池，别卡住事件循环。"""
        async with self._lock:
            result = await asyncio.to_thread(self._export_sync)
        log_event(
            LOGGER,
            logging.INFO,
            module="services.export",
            event="data.exported",
            message="数据包已导出",
            fields={
                "file": result.path.name,
                "size": result.size_bytes,
                "entries": list(result.entries),
                "skipped": list(result.skipped),
            },
        )
        return result

    # ---- 内部 --------------------------------------------------------------

    def _export_sync(self) -> ExportResult:
        self._exports_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self._now()))
        target = self._exports_dir / f"{FILE_PREFIX}{stamp}{FILE_SUFFIX}"
        temp = target.with_suffix(".tmp")
        skipped: list[str] = []
        entries: list[str] = []
        temp.unlink(missing_ok=True)
        try:
            with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                self._add_memories(archive, entries, skipped)
                self._add_usage(archive, entries, skipped)
                entries.append("settings.json")
                archive.writestr("settings.json", self._settings_json())
                self._add_characters(archive, entries, skipped)
                self._add_log_tail(archive, entries, skipped)
                archive.writestr(
                    "README.txt",
                    self._readme(target.name, entries, skipped),
                )
            temp.replace(target)
        except Exception:
            temp.unlink(missing_ok=True)
            raise
        self._prune()
        return ExportResult(
            path=target,
            size_bytes=target.stat().st_size,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(self._now())),
            entries=tuple(entries),
            skipped=tuple(skipped),
        )

    def _add_memories(
        self, archive: zipfile.ZipFile, entries: list[str], skipped: list[str]
    ) -> None:
        if self._store is None:
            skipped.append("记忆库没有打开（本次只导出设置、角色与日志）")
            return
        snapshot = self._exports_dir / ".memories-snapshot.tmp"
        snapshot.unlink(missing_ok=True)
        try:
            self._store.backup_to(snapshot)
            archive.write(snapshot, "memories.db")
            entries.append("memories.db")
        except Exception as exc:
            skipped.append(f"记忆库快照失败：{type(exc).__name__}")
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.export",
                event="data.export_memory_failed",
                message="记忆库快照失败，导出包不含记忆",
                fields={"error": type(exc).__name__, "detail": str(exc)},
            )
        finally:
            snapshot.unlink(missing_ok=True)

    def _add_usage(self, archive: zipfile.ZipFile, entries: list[str], skipped: list[str]) -> None:
        source = self._settings.usage_db_file
        if not source.is_file():
            skipped.append("没有使用统计库")
            return
        snapshot = self._exports_dir / ".usage-snapshot.tmp"
        snapshot.unlink(missing_ok=True)
        try:
            # sqlite3 的连接上下文管理器只提交/回滚事务，不会关闭连接；
            # Windows 上没关掉的句柄会让 finally 里的 unlink 报 PermissionError（真机验收抓到）。
            with (
                closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as conn,
                closing(sqlite3.connect(snapshot)) as target,
            ):
                conn.backup(target)
            archive.write(snapshot, "usage.db")
            entries.append("usage.db")
        except Exception as exc:
            skipped.append(f"使用统计库读不出来：{type(exc).__name__}")
        finally:
            snapshot.unlink(missing_ok=True)

    def _add_characters(
        self, archive: zipfile.ZipFile, entries: list[str], skipped: list[str]
    ) -> None:
        root = self._settings.characters_dir
        if not root.is_dir():
            skipped.append("没有角色目录")
            return
        count = 0
        for path in _iter_files(root):
            if path.stat().st_size > MAX_CHARACTER_FILE_BYTES:
                skipped.append(f"角色文件过大已跳过：{path.relative_to(root)}")
                continue
            archive.write(path, str(Path("characters") / path.relative_to(root)))
            count += 1
        if count:
            entries.append(f"characters/（{count} 个文件）")

    def _add_log_tail(
        self, archive: zipfile.ZipFile, entries: list[str], skipped: list[str]
    ) -> None:
        tail = _tail_lines(self._settings.log_file, self._log_lines)
        if tail is None:
            skipped.append("没有可读的引擎日志")
            return
        archive.writestr("logs/deskpet.log.tail", "\n".join(tail) + "\n")
        entries.append("logs/deskpet.log.tail")

    def _settings_json(self) -> str:
        payload = mask_settings(dataclasses.asdict(self._settings))
        header = {
            "_说明": "密钥已替换成占位符；换机器后需要在设置里重新填写。",
            "_版本": _repo_version(),
        }
        document = {**header, **payload}
        return json.dumps(document, ensure_ascii=False, indent=2) + "\n"

    def _readme(self, name: str, entries: Iterable[str], skipped: Iterable[str]) -> str:
        lines = [
            "Deskpet 数据导出包",
            "==================",
            "",
            f"文件：{name}",
            f"时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self._now()))}",
            "",
            "包含：",
        ]
        lines.extend(f"  - {entry}" for entry in entries)
        skipped_list = list(skipped)
        if skipped_list:
            lines.extend(["", "没有包含（原因）："])
            lines.extend(f"  - {item}" for item in skipped_list)
        lines.extend(
            [
                "",
                "怎么用：",
                "  1. 关闭 Deskpet（托盘 → 退出），确认进程已结束。",
                "  2. 把 memories.db 与 usage.db 复制到新机器的 data/ 目录（覆盖前先备份旧文件）。",
                "  3. characters/ 覆盖到新机器的 characters/；settings.json 只作对照，",
                "     密钥不会导出，需要在设置窗「模型供给」里重新填。",
                "  4. 新机器第一次启动会重建 key.blob（记忆库密钥）：用这份 memories.db 时若提示",
                "     密钥不匹配，请把旧机器的 data/key.blob 一并拷过来"
                "（它绑定当前 Windows 账号）。",
                "",
                "为什么密钥单独一个文件：key.blob 用 Windows DPAPI 加密，"
                "导出它等于把记忆明文送人，",
                "所以它不在包里；同机迁移可直接复制该文件。",
                "",
            ]
        )
        return "\n".join(lines)

    def _prune(self) -> None:
        try:
            files = sorted(
                self._exports_dir.glob(f"{FILE_PREFIX}*{FILE_SUFFIX}"),
                key=_export_sort_key,
            )
        except OSError:
            return
        for stale in files[: max(0, len(files) - self._keep)]:
            try:
                stale.unlink()
            except OSError as exc:
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="services.export",
                    event="data.export_prune_failed",
                    message="旧导出包删不掉",
                    fields={"file": stale.name, "detail": str(exc)},
                )


def _export_sort_key(path: Path) -> tuple[float, str]:
    """按文件名里的时间戳排序；解析不出来才退回 mtime（别用 mtime 当主键：复制/同步会改它）。"""
    stamp = path.name.removeprefix(FILE_PREFIX).removesuffix(FILE_SUFFIX)
    try:
        parsed = time.mktime(time.strptime(stamp, "%Y%m%d-%H%M%S"))
    except ValueError:
        try:
            parsed = path.stat().st_mtime
        except OSError:
            parsed = 0.0
    return (parsed, path.name)


def _iter_files(root: Path) -> Iterable[Path]:
    """递归列文件，不跟随符号链接（避免角色目录里放个链接把整块盘打进包里）。"""
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        yield path


def _tail_lines(path: Path, count: int) -> list[str] | None:
    """读文件尾部若干行；文件不存在或读不出来返回 None。"""
    if count <= 0 or not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = text.splitlines()
    return lines[-count:]


def _repo_version() -> str:
    """读 package.json 的版本（D8：版本唯一人工来源）；读不到返回 unknown。"""
    try:
        payload = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "unknown"
    version = payload.get("version")
    return str(version) if isinstance(version, str) else "unknown"
