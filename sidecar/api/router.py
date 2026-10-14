"""文件职责：把各路由拼成一个 APIRouter（api 层的组装点，不含业务逻辑）。

依赖方向：api -> services（仅注入），不 import adapters（CODE_STYLE §1.1）。
谁调用：sidecar/app.py（组合根）。
"""

from fastapi import APIRouter

from api.health import build_health_router
from api.stubs import build_stub_router
from services.health_service import HealthService


def build_router(health_service: HealthService) -> APIRouter:
    """构建 sidecar 全部路由：M0 只有 /health 是真实现，其余是 501 桩。"""
    router = APIRouter()
    router.include_router(build_health_router(health_service))
    router.include_router(build_stub_router())
    return router
