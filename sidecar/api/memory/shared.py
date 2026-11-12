"""文件职责：记忆路由共用的 OpenAPI 失败信封声明。

依赖方向：api -> contracts；不 import services / adapters。
谁调用：api/memory/ 下每个按域拆分的路由模块。
"""

from __future__ import annotations

from typing import Any

from contracts.errors import ErrorEnvelope

#: 可能的失败信封写进 OpenAPI，前端据此写错误处理（DP-MEM-001 / 002 / 003 都是 500）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}

__all__ = ["_ERROR_RESPONSES"]
