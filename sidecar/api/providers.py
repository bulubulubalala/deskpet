"""文件职责：POST /providers/test 的薄路由（只做入参校验与序列化，逻辑在 services）。

依赖方向：api -> services（注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_providers_router()。

安全：响应模型里没有 api_key（contracts/providers.py 的硬约束），密钥只进探测函数、不回声。
"""

from fastapi import APIRouter

from contracts.providers import ProviderTestRequest, ProviderTestResponse
from contracts.routes import API_ROUTES
from services.provider_test_service import ProviderTestService

_TEST_ROUTE = next(route for route in API_ROUTES if route.path == "/providers/test")


def build_providers_router(provider_test_service: ProviderTestService) -> APIRouter:
    """把 /providers/test 挂到独立 router 上；服务实例由组合根注入（CODE_STYLE §1.4）。"""
    router = APIRouter(tags=["providers"])

    @router.post(
        _TEST_ROUTE.path,
        response_model=ProviderTestResponse,
        summary=_TEST_ROUTE.purpose,
    )
    async def test_provider(request: ProviderTestRequest) -> ProviderTestResponse:
        """探测选中能力面的候选端点；只回结论与耗时，绝不回密钥（§6.13）。"""
        return await provider_test_service.test(request.capability)

    return router
