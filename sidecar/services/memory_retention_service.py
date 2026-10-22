"""记忆保留期后台任务：启动时先清一次，之后每 6 小时清一次。"""

from __future__ import annotations

import asyncio
import logging

from core.logging import get_logger, log_event
from services.memory_service import MemoryService

LOGGER = get_logger("services.memory_retention_service")
DEFAULT_INTERVAL_S = 6 * 3600.0


class MemoryRetentionService:
    def __init__(self, memory: MemoryService, *, interval_s: float = DEFAULT_INTERVAL_S) -> None:
        self._memory = memory
        self._interval_s = interval_s

    async def run_once(self) -> dict[str, int]:
        try:
            counts = await asyncio.to_thread(self._memory.purge_expired)
            if any(counts.values()):
                log_event(
                    LOGGER,
                    logging.INFO,
                    module="services.memory_retention",
                    event="memory.retention",
                    message="记忆保留期清理完成",
                    fields=dict(counts.items()),
                )
            return counts
        except Exception as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_retention",
                event="memory.retention_failed",
                message="记忆保留期清理失败，本轮跳过",
                fields={"error": type(exc).__name__, "detail": str(exc)},
            )
            return {"messages": 0, "summaries": 0, "memories": 0}

    async def run_forever(self) -> None:
        while True:
            await self.run_once()
            await asyncio.sleep(self._interval_s)
