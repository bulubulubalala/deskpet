"""文件职责：sidecar HTTP 契约测试（需求 §6.3；PLAN T0.3 的验收）。

依赖方向：tests -> contracts / app（组合根）+ FastAPI TestClient；不需要 GPU 或音频硬件。
谁调用：pytest（本地与未来的 CI）。
"""

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app import create_app
from contracts import api_models
from contracts.errors import CODE_NOT_IMPLEMENTED, ErrorEnvelope
from contracts.health import HealthResponse, ModuleName, ModuleState
from contracts.routes import (
    API_ROUTES,
    ApiRoute,
    JSON_MEDIA_TYPE,
    IMPLEMENTED_ROUTES,
    PCM_MEDIA_TYPE,
    SSE_MEDIA_TYPE,
)

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


def test_implemented_routes_match_plan() -> None:
    """真实现的路由在这里逐条记账：M0 只有 /health，T1.3 加了 /chat/stream，T1.4 加了 /asr。

    要改这条断言必须同时改 contracts/routes.py 与 docs/PLAN.md——这是防止
    「桩还挂着、实现已删除」或「实现完成但契约仍写未实现」的保险丝。
    """
    assert IMPLEMENTED_ROUTES == frozenset(
        {("GET", "/health"), ("POST", "/chat/stream"), ("POST", "/asr")}
    )


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


# 每条桩路由的最小合法请求：M1 的路由都已声明模型，参数校验发生在 501 之前，
# 所以这里必须给出「能过校验」的入参，才能验证 501 本身（校验失败的 422 另有测试覆盖）。
# 已实现的路由不在这里（它们不再返回 501）；T1.3 摘掉 /chat/stream，T1.4 摘掉 /asr。
_STUB_CALLS: dict[tuple[str, str], dict[str, Any]] = {
    ("POST", "/tts"): {"json": {"text": "你好", "voice_id": "amber", "request_id": "probe"}},
    ("POST", "/tts/cancel"): {"json": {"request_id": "probe"}},
    ("POST", "/gpu/lock"): {"json": {"holder": "tts", "request_id": "probe"}},
}


def test_unimplemented_routes_return_error_envelope() -> None:
    """未实现的路由必须是 501 + 错误信封（不是 404 / 500），前端才能写出正确提示。"""
    with _client() as client:
        for route in API_ROUTES:
            if route.implemented:
                continue
            path = route.path
            for param in route.path_params:
                path = path.replace("{" + param + "}", "1")
            response = client.request(
                route.method, path, **_STUB_CALLS.get((route.method, route.path), {})
            )
            assert response.status_code == 501, f"{route.method} {route.path}"
            envelope = ErrorEnvelope.model_validate(response.json()["detail"])
            assert envelope.code == CODE_NOT_IMPLEMENTED
            assert envelope.user_hint is None


def test_openapi_snapshot_matches_app() -> None:
    """提交的 openapi.json 必须与 app 一致；改了契约就要重跑 scripts/export_openapi.py。"""
    assert OPENAPI_SNAPSHOT.is_file(), "缺少契约快照：执行 python scripts/export_openapi.py"
    snapshot = json.loads(OPENAPI_SNAPSHOT.read_text(encoding="utf-8"))
    assert snapshot == create_app().openapi()


def _operation(document: dict, route: ApiRoute) -> dict:
    """取某个路由在 OpenAPI 里的 operation 对象。"""
    return document["paths"][route.path][route.method.lower()]


def test_declared_models_match_openapi() -> None:
    """routes.py 声明的 query / 请求体 / 响应模型必须真的出现在 OpenAPI 里（T1.1 契约）。

    这是「契约先行」的保险丝：模型名写错、忘了挂到路由上、或媒体类型漂移，这里就会红。
    字段留空的路由（M2/M4 才细化）跳过，但至少要有一条 M1 路由真的被检查过。
    """
    document = create_app().openapi()
    schemas = document["components"]["schemas"]
    checked = 0
    for route in API_ROUTES:
        operation = _operation(document, route)
        label = f"{route.method} {route.path}"
        if route.query_model is not None:
            model = getattr(api_models, route.query_model)
            expected = sorted(model.model_fields)
            actual = sorted(
                parameter["name"]
                for parameter in operation.get("parameters", [])
                if parameter["in"] == "query"
            )
            assert actual == expected, f"{label} 的 query 参数与 {route.query_model} 不一致"
            checked += 1
        if route.request_model is not None:
            media = route.request_media_type or JSON_MEDIA_TYPE
            content = operation["requestBody"]["content"]
            assert media in content, f"{label} 缺少请求体媒体类型 {media}"
            assert content[media]["schema"]["$ref"] == f"#/components/schemas/{route.request_model}"
            checked += 1
        elif route.request_media_type is not None:
            # /asr：请求体是原始 PCM，没有 JSON 模型可引用（openapi_extra 声明）
            assert route.request_media_type == PCM_MEDIA_TYPE, label
            assert route.request_media_type in operation["requestBody"]["content"], label
            checked += 1
        if route.response_model is not None:
            schema = operation["responses"]["200"]["content"][JSON_MEDIA_TYPE]["schema"]
            assert schema["$ref"] == f"#/components/schemas/{route.response_model}", label
            checked += 1
        if route.response_media_type is not None:
            assert route.response_media_type in operation["responses"]["200"]["content"], label
            checked += 1
    assert checked >= 5, "M1 的模型级契约至少应覆盖五条路由"


def test_chat_stream_documents_llm_event_discriminators() -> None:
    """§6.3 的 /chat/stream 必须把 §6.2 的五种事件类型写进 OpenAPI（前端据此分派）。

    app/main/ipc.ts 的 CHAT_EVENT_KINDS 与本断言、contracts/events.py 的判别字段三处同源，
    跨语言对账在 tests/ipc-contract.test.ts。
    """
    document = create_app().openapi()
    schema = document["paths"]["/chat/stream"]["post"]["responses"]["200"]["content"][SSE_MEDIA_TYPE][
        "schema"
    ]
    assert schema["properties"]["t"]["enum"] == ["s", "m", "a", "end", "e"]
