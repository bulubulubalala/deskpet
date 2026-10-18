"""文件职责：POST /usage/record 的 HTTP 行为测试（T2.3-C1，需求 §6.3 / §6.9）。

依赖方向：tests -> app（组合根）+ services.usage_service + FastAPI TestClient；
统计库建在 tmp_path 下，不碰仓库 data/，也不依赖模型或硬件。
谁调用：pytest。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app
from config import Settings
from services.usage_service import build_usage_service


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """真统计库（临时目录）+ 真组合根：验的是从 HTTP 到 usage.db 的整条链。"""
    service = build_usage_service(Settings(data_dir=tmp_path))
    with TestClient(create_app(usage_service=service)) as client:
        yield client


def test_window_shake_is_recorded_without_a_chat_session(client: TestClient) -> None:
    """还没聊过也能记账（此时落进 ui: 会话）；对界面而言只是 recorded=true。"""
    response = client.post("/usage/record", json={"fact": "window_shake", "char_id": "amber"})

    assert response.status_code == 200, response.text
    assert response.json() == {"recorded": True}


def test_shake_without_character_is_not_recorded(client: TestClient) -> None:
    """没有角色不知道记给谁：这是明确拒绝，不是错误（recorded=false）。"""
    response = client.post("/usage/record", json={"fact": "window_shake", "char_id": ""})

    assert response.status_code == 200, response.text
    assert response.json() == {"recorded": False}


def test_unknown_fact_is_rejected_by_contract(client: TestClient) -> None:
    """fact 是白名单：主进程写别的值直接 422，不允许悄悄记别的事实。"""
    response = client.post("/usage/record", json={"fact": "mouse_click", "char_id": "amber"})

    assert response.status_code == 422
