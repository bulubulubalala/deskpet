"""api 层出口：HTTP 边界（薄路由，只做参数校验 / 调 service / 序列化）。

依赖方向：api -> services -> core；禁止 import adapters 的实现细节（CODE_STYLE §1.1）。
"""

from api.health import build_health_router
from api.router import build_router
from api.stubs import build_stub_router

__all__ = [
    "build_health_router",
    "build_router",
    "build_stub_router",
]
