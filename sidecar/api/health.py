"""文件职责：GET /health 的路由（薄路由：只序列化，逻辑在 services/health_service.py）。

依赖方向：api -> services + contracts（CODE_STYLE §1.1），不 import adapters / core。
谁调用：sidecar/api/router.py 在组合根里构建路由时调用 build_health_router()。
"""

from fastapi import APIRouter

from contracts.health import HealthResponse
from contracts.routes import API_ROUTES
from services.health_service import HealthService

_HEALTH_ROUTE = API_ROUTES[0]


def build_health_router(health_service: HealthService) -> APIRouter:
    """把 /health 挂到独立 router 上；服务实例由组合根注入（CODE_STYLE §1.4）。"""
    router = APIRouter(tags=["health"])

    @router.get(
        _HEALTH_ROUTE.path,
        response_model=HealthResponse,
        summary=_HEALTH_ROUTE.purpose,
    )
    async def get_health() -> HealthResponse:
        """返回心跳数据；不得加载模型、不得抢 GPU 锁（需求 §6.3）。"""
        return health_service.snapshot()

    return router
