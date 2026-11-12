"""文件职责：数据导出 / 恢复路由（D9 / M3）——薄路由，只序列化，逻辑在 services 里。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters / core。
谁调用：sidecar/api/router.py 构建路由时调用 build_data_router()。
约定：导出与恢复都是用户主动动作，失败要让他看见原因，所以这里不吞异常——交给
api/error_handlers.py 统一转失败信封（与备份这类后台任务相反）。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from contracts.data import (
    BackupEntry,
    DataBackupNowResponse,
    DataBackupsResponse,
    DataExportResponse,
    DataRestoreRequest,
    DataRestoreResponse,
)
from contracts.errors import ErrorEnvelope
from services.backup_service import MemoryBackupService
from services.export_service import DataExportService
from services.restore_service import DataRestoreService

#: 401 写进 OpenAPI（本机回环也带 token，§6.10）；500 是打包/解包失败（磁盘满、文件被占用、
#: 恢复包不合法——恢复包不合法用的是 DP-MEM-004，同样是 500 信封 + 用户可读的 user_hint）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}


def build_data_router(
    export_service: DataExportService,
    restore_service: DataRestoreService,
    backup_service: MemoryBackupService | None = None,
) -> APIRouter:
    """把 /data/* 挂到独立 router 上；服务实例由组合根注入（CODE_STYLE §1.4）。"""
    router = APIRouter(tags=["data"])

    @router.post(
        "/data/export",
        response_model=DataExportResponse,
        summary="导出数据包：记忆库快照 + 设置（密钥脱敏）+ 角色 + 日志摘要",
        responses=_ERROR_RESPONSES,
    )
    async def export_data() -> DataExportResponse:
        """同步打包在线程池里跑；返回值只给路径与清单，不回任何密钥内容。"""
        result = await export_service.export()
        return DataExportResponse(
            path=str(result.path),
            bytes=result.size_bytes,
            created_at=result.created_at,
            entries=list(result.entries),
            skipped=list(result.skipped),
        )

    @router.post(
        "/data/restore",
        response_model=DataRestoreResponse,
        summary="从数据包恢复记忆库（先暂存，重启引擎后生效）",
        responses=_ERROR_RESPONSES,
    )
    async def restore_data(request: DataRestoreRequest) -> DataRestoreResponse:
        """只把库解到暂存目录：在线替换会把正在使用的连接写丢（见 services/restore_service.py）。"""
        staged = await restore_service.stage(Path(request.path))
        return DataRestoreResponse(
            archive=str(staged.archive),
            db_bytes=staged.db_bytes,
            pending_path=str(staged.pending_path),
            entries=list(staged.entries),
        )

    @router.get(
        "/data/backups",
        response_model=DataBackupsResponse,
        summary="列出记忆库备份（每日快照 / 操作前留底 / 恢复残骸）",
        responses=_ERROR_RESPONSES,
    )
    async def list_backups() -> DataBackupsResponse:
        """只读：数目录、算大小；界面据此显示「有哪些后悔药」，删除仍归各自的保留策略。"""
        if backup_service is None:
            return DataBackupsResponse(dir="", total_bytes=0, entries=[])
        entries = await asyncio.to_thread(backup_service.list_files)
        return DataBackupsResponse(
            dir=str(backup_service.backup_dir),
            total_bytes=sum(entry.bytes for entry in entries),
            entries=[
                BackupEntry(
                    file=entry.file,
                    kind=entry.kind,
                    bytes=entry.bytes,
                    modified_at=entry.modified_at,
                )
                for entry in entries
            ],
        )

    @router.post(
        "/data/backup",
        response_model=DataBackupNowResponse,
        summary="立即给记忆库做一份快照（用户主动点按钮）",
        responses=_ERROR_RESPONSES,
    )
    async def backup_now() -> DataBackupNowResponse:
        """与操作前留底同一条 VACUUM INTO 路径；失败时返回空路径，由界面说一句「没做成」。"""
        if backup_service is None:
            return DataBackupNowResponse()
        path = await backup_service.snapshot_now()
        if path is None:
            return DataBackupNowResponse()
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        return DataBackupNowResponse(path=str(path), file=path.name, bytes=size)

    return router
