"""文件职责：记忆路由的装配——按域把六组路由挂到同一个 router 上。

为什么还要这一层：api/router.py 只认识一个入口 build_memory_router()；
具体每个域有哪些接口、各自需要什么依赖，由对应模块自己声明。

依赖方向：api -> services（仅注入）；不 import adapters。
谁调用：sidecar/api/router.py。
"""

from __future__ import annotations

from fastapi import APIRouter

from services.backup_service import MemoryBackupService
from services.memory_service import MemoryService
from services.usage_service import UsageService

from .context import register_context_routes
from .embeddings import register_embedding_routes
from .memories import register_memory_routes
from .messages import register_message_routes
from .relations import register_relation_routes
from .timeline import register_timeline_routes


def build_memory_router(
    service: MemoryService,
    usage: UsageService,
    backup: MemoryBackupService | None = None,
) -> APIRouter:
    """把记忆相关路由挂成真实现；按域分组，桩在 api/stubs.py 里对应删除。"""
    router = APIRouter(tags=["memory"])
    register_memory_routes(router, service, usage, backup=backup)
    register_embedding_routes(router, service)
    register_timeline_routes(router, service)
    register_relation_routes(router, service)
    register_message_routes(router, service)
    register_context_routes(router, service)
    return router


__all__ = ["build_memory_router"]
