"""文件职责：记忆管理五条路由的 HTTP 行为测试（需求 §6.3 / §6.4；PLAN T2.1a）。

依赖方向：tests -> app（组合根）+ services.memory_service + FastAPI TestClient；
用临时数据目录里的真记忆库跑完整往返，失败路径用注入 startup_error 的服务模拟。
谁调用：pytest。
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app
from config import MemorySettings, Settings
from contracts.errors import CODE_MEM_KEY_INVALID, ErrorEnvelope
from core.memory import MemoryKeyInvalidError, parse_iso_time
from services.memory_service import MemoryService, build_memory_service

CHAR = "amber"


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """真记忆库（临时目录）+ 真组合根：这组用例验证的是契约到落盘的整条链。"""
    service = build_memory_service(Settings(data_dir=tmp_path))
    with TestClient(create_app(memory_service=service)) as client:
        yield client


def _write(client: TestClient, text: str, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {"char_id": CHAR, "kind": "fact", "text": text}
    payload.update(overrides)
    response = client.post("/memory/write", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_write_list_search_delete_roundtrip(client: TestClient) -> None:
    """一轮完整往返：写 → 列 → 搜 → 重复写（去重）→ 删。"""
    created = _write(client, "用户养了一只叫团子的猫", importance=0.8)
    assert created["deduped"] is False
    memory_id = created["id"]

    listing = client.get("/memory/list", params={"char_id": CHAR})
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == memory_id
    assert items[0]["text"] == "用户养了一只叫团子的猫"
    assert items[0]["created_at"], "边界上的时间必须是 ISO 字符串"
    assert items[0]["last_used_at"] == "", "没被用过就是空串"
    assert items[0]["used_count"] == 0

    hits = client.get("/memory/search", params={"char_id": CHAR, "query": "猫"}).json()["items"]
    assert [hit["id"] for hit in hits] == [memory_id]
    assert hits[0]["occurred_at"]
    assert hits[0]["score"] > 0

    again = _write(client, "  用户养了一只叫团子的猫 ", importance=0.4)
    assert again == {"id": memory_id, "deduped": True}, "同一句话只抬重要度，不新增行"

    deleted = client.delete("/memory/" + str(memory_id))
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert client.get("/memory/list", params={"char_id": CHAR}).json()["items"] == []
    assert client.get("/memory/search", params={"char_id": CHAR, "query": "猫"}).json()["items"] == []


def test_delete_missing_memory_is_idempotent(client: TestClient) -> None:
    """删不存在的 id 返回 200 + deleted=False：界面上重复点删除不该报错。"""
    assert client.delete("/memory/4242").json() == {"deleted": False}


def test_delete_rejects_non_positive_id(client: TestClient) -> None:
    assert client.delete("/memory/0").status_code == 422


def test_write_keeps_provided_occurred_at(client: TestClient) -> None:
    """occurred_at 是「这件事什么时候发生」——L0 的排序与时间衰减都靠它。"""
    _write(client, "用户去年搬家了", occurred_at="2024-01-02T03:04:05+00:00")
    item = client.get("/memory/list", params={"char_id": CHAR}).json()["items"][0]
    # 列表里的 ISO 串按本机时区渲染，所以比「同一时刻」而不是比字符串前缀
    assert parse_iso_time(item["created_at"]) == parse_iso_time("2024-01-02T03:04:05+00:00")


def test_clear_keeps_recent_days(client: TestClient) -> None:
    """keep_days=30 时刚写的还在；不带 keep_days 才是清空。"""
    _write(client, "用户养了一只猫")
    kept = client.post("/memory/clear", json={"char_id": CHAR, "keep_days": 30})
    assert kept.status_code == 200
    assert kept.json() == {"deleted": 0}
    assert len(client.get("/memory/list", params={"char_id": CHAR}).json()["items"]) == 1
    assert client.post("/memory/clear", json={"char_id": CHAR}).json() == {"deleted": 1}


def test_list_filters_by_kind(client: TestClient) -> None:
    _write(client, "用户在上海工作")
    _write(client, "用户喜欢猫", kind="preference")
    only_preference = client.get("/memory/list", params={"char_id": CHAR, "kind": "preference"})
    assert [item["text"] for item in only_preference.json()["items"]] == ["用户喜欢猫"]


def test_search_and_list_validate_params(client: TestClient) -> None:
    """参数校验必须发生在业务之前：非法 limit / 空 query 一律 422。"""
    assert client.get("/memory/search", params={"char_id": CHAR, "query": ""}).status_code == 422
    assert client.get("/memory/search", params={"char_id": CHAR, "query": "猫", "limit": 0}).status_code == 422
    assert client.get("/memory/list", params={"char_id": CHAR, "limit": 999}).status_code == 422
    assert client.get("/memory/list", params={"kind": "unknown"}).status_code == 422
    assert client.post("/memory/write", json={"char_id": CHAR, "kind": "fact", "text": ""}).status_code == 422


def test_unavailable_memory_store_returns_dp_mem_envelope() -> None:
    """记忆库打不开时，管理端点必须回 500 + DP-MEM-001 + 用户指引（不能静默返回空列表）。"""
    service = MemoryService(
        None,
        MemorySettings(),
        startup_error=MemoryKeyInvalidError("密钥读不出来"),
    )
    with TestClient(create_app(memory_service=service)) as client:
        for method, path, kwargs in [
            ("GET", "/memory/search", {"params": {"char_id": CHAR, "query": "猫"}}),
            ("GET", "/memory/list", {"params": {"char_id": CHAR}}),
            ("POST", "/memory/write", {"json": {"char_id": CHAR, "kind": "fact", "text": "猫"}}),
            ("DELETE", "/memory/1", {}),
            ("POST", "/memory/clear", {"json": {"char_id": CHAR}}),
        ]:
            response = client.request(method, path, **kwargs)
            assert response.status_code == 500, f"{method} {path}"
            envelope = ErrorEnvelope.model_validate(response.json())
            assert envelope.code == CODE_MEM_KEY_INVALID, f"{method} {path}"
            assert envelope.user_hint, f"{method} {path} 缺少用户指引"
