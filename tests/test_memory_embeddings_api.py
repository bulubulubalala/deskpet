"""文件职责：语义检索状态/补索引路由的 HTTP 契约（T2.31）。"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app
from config import Settings
from services.memory_service import build_memory_service


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    service = build_memory_service(Settings(data_dir=tmp_path))
    with TestClient(create_app(memory_service=service)) as test_client:
        yield test_client


def test_embedding_status_disabled_by_default(client: TestClient) -> None:
    response = client.get("/memory/embeddings/status", params={"char_id": "xiaoyu"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["available"] is False
    assert payload["model"] == "bge-m3"
    # 默认仍是外接 Ollama（provider=ollama），内置 onnx 只在显式配置/新 .env 时启用
    assert payload["provider"] == "ollama"
    assert payload["model_dir"] == ""


def test_embedding_index_when_disabled_does_not_raise(client: TestClient) -> None:
    response = client.post(
        "/memory/embeddings/index",
        json={"char_id": "xiaoyu", "limit": 10},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["indexed"] == 0
    assert payload["error"] == "语义检索未启用"
