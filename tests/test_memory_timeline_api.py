"""文件职责：时间线 / 日记 / 关系记忆的 HTTP 契约测试（T2.33）。"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from core.memory import DiaryDraft
from fastapi.testclient import TestClient
from services.memory_service import build_memory_service

from app import create_app
from config import Settings

CHAR = "xiaoyu"
NOW = 1_700_000_000.0


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    service = build_memory_service(Settings(data_dir=tmp_path))
    with TestClient(create_app(memory_service=service)) as client:
        yield client


def test_timeline_list_and_detail(client: TestClient) -> None:
    service = client.app.state.memory_service
    store = service.store
    assert store is not None
    period_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天面试完了，有点累。",
        label="2023-11-14",
        day_key="2023-11-14",
        sources=[("message", 1)],
        now=NOW,
    )

    listing = client.get("/memory/timeline", params={"char_id": CHAR}).json()["items"]
    assert listing[0]["id"] == period_id
    assert listing[0]["level"] == "day"
    assert listing[0]["summary"] == "今天面试完了，有点累。"

    detail = client.get(f"/memory/timeline/{period_id}").json()
    assert detail["sources"] == [["message", 1]]

    edited = client.patch(
        f"/memory/timeline/{period_id}",
        json={"summary": "手动改过的回忆。", "pinned": True},
    )
    assert edited.status_code == 200
    assert edited.json()["summary"] == "手动改过的回忆。"
    assert edited.json()["pinned"] is True
    assert edited.json()["edited"] is True


def test_memory_graph_returns_period_nodes_and_edges(client: TestClient) -> None:
    service = client.app.state.memory_service
    store = service.store
    assert store is not None
    period_id = store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW,
        period_end=NOW + 86400,
        summary="今天聊了面试。",
        label="2023-11-14",
        day_key="2023-11-14",
        sources=[("diary", 9)],
        now=NOW,
    )
    diary = store.add_diary(DiaryDraft(CHAR, "今天有点累。", NOW), now=NOW)
    store.upsert_period(
        char_id=CHAR,
        level="day",
        period_start=NOW + 86400,
        period_end=NOW + 2 * 86400,
        summary="第二天。",
        label="2023-11-15",
        day_key="2023-11-15",
        sources=[("diary", diary.entry_id)],
        now=NOW,
    )

    payload = client.get("/memory/graph", params={"char_id": CHAR}).json()
    assert any(node["id"] == f"period:{period_id}" for node in payload["nodes"])
    assert any(edge["relation"] == "contains" for edge in payload["edges"])


def test_diary_crud(client: TestClient) -> None:
    created = client.post(
        "/memory/diary",
        json={
            "char_id": CHAR,
            "text": "今天面试完了，有点累。",
            "occurred_at": "2023-11-14T20:00:00+08:00",
            "mood": "累",
            "tags": "工作",
        },
    )
    assert created.status_code == 200, created.text
    entry = created.json()
    assert entry["text"] == "今天面试完了，有点累。"
    assert entry["mood"] == "累"

    listing = client.get("/memory/diary", params={"char_id": CHAR}).json()["items"]
    assert [item["id"] for item in listing] == [entry["id"]]

    edited = client.patch(
        f"/memory/diary/{entry['id']}", json={"text": "今天面试很顺利", "mood": "开心"}
    )
    assert edited.status_code == 200
    assert edited.json()["text"] == "今天面试很顺利"
    assert edited.json()["mood"] == "开心"

    assert client.delete(f"/memory/diary/{entry['id']}").json() == {"deleted": True}
    assert client.get("/memory/diary", params={"char_id": CHAR}).json()["items"] == []


def test_intentions_crud(client: TestClient) -> None:
    created = client.post(
        "/memory/intentions",
        json={"char_id": CHAR, "text": "下次问面试结果"},
    )
    assert created.status_code == 200, created.text
    item = created.json()
    listing = client.get("/memory/intentions", params={"char_id": CHAR}).json()["items"]
    assert [entry["id"] for entry in listing] == [item["id"]]
    resolved = client.post("/memory/intentions/" + str(item["id"]) + "/resolve")
    assert resolved.status_code == 200
    assert resolved.json() == {"deleted": True}
    assert client.get("/memory/intentions", params={"char_id": CHAR}).json()["items"] == []


def test_relation_roundtrip(client: TestClient) -> None:
    initial = client.get("/memory/relation", params={"char_id": CHAR})
    assert initial.status_code == 200
    assert initial.json()["char_id"] == CHAR
    assert initial.json()["trust"] == 0.5

    saved = client.put(
        "/memory/relation",
        params={"char_id": CHAR},
        json={
            "familiarity": 0.7,
            "trust": 0.8,
            "warmth": 0.6,
            "unresolved": "面试结果",
            "recent_conflict": "",
        },
    )
    assert saved.status_code == 200
    assert saved.json()["trust"] == 0.8
    loaded = client.get("/memory/relation", params={"char_id": CHAR}).json()
    assert loaded["unresolved"] == "面试结果"
