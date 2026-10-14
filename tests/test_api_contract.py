"""文件职责：sidecar HTTP 契约测试（需求 §6.3；PLAN T0.3 的验收）。

依赖方向：tests -> contracts / app（组合根）+ FastAPI TestClient；不需要 GPU 或音频硬件。
谁调用：pytest（本地与未来的 CI）。
"""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import create_app
from contracts.errors import CODE_NOT_IMPLEMENTED, ErrorEnvelope
from contracts.health import HealthResponse, ModuleName, ModuleState
from contracts.routes import API_ROUTES, M0_IMPLEMENTED_ROUTES

REPO_ROOT = Path(__file__).resolve().parents[1]
OPENAPI_SNAPSHOT = REPO_ROOT / "sidecar" / "contracts" / "openapi.json"


def _client() -> TestClient:
    """每个测试用独立 app，避免状态串味。"""
    return TestClient(create_app())


def _mounted_routes() -> set[tuple[str, str]]:
    """实际挂载的（方法, 路径）集合，取自 app.openapi()。

    说明：FastAPI 0.143 起 include_router 会包一层 _IncludedRouter，app.routes 不再是扁平的
    路由列表；openapi() 由实际路由生成，既跨版本稳定，又顺带验证路由确实进了 API 文档。
    """
    paths = create_app().openapi()["paths"]
    return {(method.upper(), path) for path, operations in paths.items() for method in operations}


def test_route_table_matches_mounted_routes() -> None:
    """contracts/routes.py 的路由表与 FastAPI 实际挂载的路由必须完全一致（契约漂移防线）。"""
    expected = {(route.method, route.path) for route in API_ROUTES}
    assert _mounted_routes() == expected


def test_m0_only_implements_health() -> None:
    """M0 真实现只有 GET /health（PLAN T0.3）；要改这条断言必须同时改 PLAN。"""
    assert M0_IMPLEMENTED_ROUTES == frozenset({("GET", "/health")})


def test_health_returns_full_snapshot_shape() -> None:
    """GET /health 返回 HealthResponse 的全部字段，六个模块都是 idle（M0 不加载模型）。"""
    with _client() as client:
        response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == set(HealthResponse.model_fields)
    assert payload["status"] == "ok"
    assert payload["uptime_s"] >= 0
    assert [module["name"] for module in payload["modules"]] == [name.value for name in ModuleName]
    assert {module["state"] for module in payload["modules"]} == {ModuleState.IDLE.value}
    assert payload["gpu"]["loaded_mb"] == 0


def test_unimplemented_routes_return_error_envelope() -> None:
    """未实现的路由必须是 501 + 错误信封（不是 404 / 500），前端才能写出正确提示。"""
    with _client() as client:
        for route in API_ROUTES:
            if route.m0_implemented:
                continue
            path = route.path
            for param in route.path_params:
                path = path.replace("{" + param + "}", "1")
            response = client.request(route.method, path)
            assert response.status_code == 501, f"{route.method} {route.path}"
            envelope = ErrorEnvelope.model_validate(response.json()["detail"])
            assert envelope.code == CODE_NOT_IMPLEMENTED
            assert envelope.user_hint is None


def test_openapi_snapshot_matches_app() -> None:
    """提交的 openapi.json 必须与 app 一致；改了契约就要重跑 scripts/export_openapi.py。"""
    assert OPENAPI_SNAPSHOT.is_file(), "缺少契约快照：执行 python scripts/export_openapi.py"
    snapshot = json.loads(OPENAPI_SNAPSHOT.read_text(encoding="utf-8"))
    assert snapshot == create_app().openapi()
