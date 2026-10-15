"""文件职责：把各路由拼成一个 APIRouter（api 层的组装点，不含业务逻辑）。

依赖方向：api -> services（仅注入），不 import adapters（CODE_STYLE §1.1）。
谁调用：sidecar/app.py（组合根）。
"""

from fastapi import APIRouter

from api.chat import build_chat_router
from api.health import build_health_router
from api.stubs import build_stub_router
from services.chat_service import ChatService
from services.health_service import HealthService


def build_router(health_service: HealthService, chat_service: ChatService) -> APIRouter:
    """构建 sidecar 全部路由：已实现的挂真处理器，其余按 contracts/routes.py 挂 501 桩。"""
    router = APIRouter()
    router.include_router(build_health_router(health_service))
    router.include_router(build_chat_router(chat_service))
    router.include_router(build_stub_router())
    return router
