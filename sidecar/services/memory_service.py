"""文件职责：记忆用例层的对外入口（实现按域拆在 services/memory/ 目录）。

保留这个文件是为了让 «from services.memory_service import ...» 的所有调用方一行都不用改。
"""

from __future__ import annotations

from services.memory import MemoryService, build_memory_service

__all__ = ["MemoryService", "build_memory_service"]
