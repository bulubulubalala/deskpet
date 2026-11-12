"""文件职责：把各域 mixin 汇总成一个 MemoryService，并给出开库入口 build_memory_service。

为什么这样拆：记忆用例按「谁在用」分成六组（注入装配 / 语义索引 / 条目 / 原文与摘要 /
时间线与日记 / 关系与待办），每组只依赖底座里的 store 与 settings；改日记不必再
在一千行的类里找上下文。

依赖方向：services -> adapters（库与密钥在这里建好注入）/ core / contracts；不 import api。
谁调用：sidecar/app.py 组合根；api/memory/ 与 ChatService 通过接口使用。
"""

from __future__ import annotations

import logging

from adapters.memory_key import load_or_create_key
from adapters.memory_sqlite import open_memory_store
from config import Settings
from core.env_events import EnvEventReporter
from core.logging import log_event
from core.memory import (
    MemoryBackendError,
    MemoryStore,
)
from services.restore_service import apply_pending_restore

from . import embeddings as embedding_parts
from .base import LOGGER, MemoryServiceBase
from .memories import MemoriesMixin
from .messages import MessagesMixin
from .recall import RecallMixin
from .relations import RelationsMixin
from .timeline import TimelineMixin


class MemoryService(
    RecallMixin,
    embedding_parts.EmbeddingMixin,
    MemoriesMixin,
    MessagesMixin,
    TimelineMixin,
    RelationsMixin,
    MemoryServiceBase,
):
    """记忆用例层：三个吞失败的对话方法 + 一组会抛错的管理方法（各域见同目录 mixin）。"""


def build_memory_service(
    settings: Settings,
    *,
    env: EnvEventReporter | None = None,
    store: MemoryStore | None = None,
) -> MemoryService:
    """组合根用的构造器：密钥 → 打开（或建）加密库 → 注入配置与事件总线。

    打开失败（密钥读不出、目录只读、索引损坏）不抛异常：降级成「没有记忆」的服务，
    由 /health 的 memory 模块状态与设置界面把原因告诉用户（§6.4 / §6.7 A 级）。
    """
    startup_error: MemoryBackendError | None = None
    if store is None:
        try:
            key = load_or_create_key(settings.memory_key_file)
            # D9 恢复：有暂存的导入包就先把库换掉（换完已用同一把密钥试开过，失败会自己回滚）
            apply_pending_restore(settings, key=key)
            store = open_memory_store(settings.memory_db_file, key=key)
        except MemoryBackendError as exc:
            startup_error = exc
            log_event(
                LOGGER,
                logging.ERROR,
                module="services.memory_service",
                event="memory.unavailable",
                message="记忆库打不开，本次运行不记也不读记忆",
                fields={"reason": type(exc).__name__, "error": str(exc)},
            )
    return MemoryService(
        store,
        settings.memory,
        env=env,
        startup_error=startup_error,
    )


__all__ = ["LOGGER", "MemoryService", "build_memory_service"]
