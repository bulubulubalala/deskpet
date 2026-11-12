"""文件名职责：备份可见性——`list_files` 的分类/排序/跳过空文件，以及 /data/backups 与 /data/backup 的契约。

为什么单独测：这两条路由只读目录、不碰数据库，用假 store 就能覆盖；
真库的 VACUUM INTO 一致性由 tests/test_backup_service.py 与集成测试负责。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.data import build_data_router
from services.backup_service import MemoryBackupService


class FakeStore:
    """只实现快照写盘。"""

    def __init__(self, *, payload: bytes = b"sqlite-snapshot", error: Exception | None = None) -> None:
        self.payload = payload
        self.error = error

    def backup_to(self, path: Path) -> None:
        if self.error is not None:
            raise self.error
        path.write_bytes(self.payload)


class FakeExport:
    async def export(self):  # pragma: no cover - 本文件不使用
        raise AssertionError("不应调用")


class FakeRestore:  # pragma: no cover - 本文件不使用
    async def stage(self, path: Path):
        raise AssertionError("不应调用")


def make_service(tmp_path: Path, *, store: FakeStore | None = None) -> MemoryBackupService:
    return MemoryBackupService(store, tmp_path / "backups", keep=7, now=time.time)


def touch(path: Path, size: int, *, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    # 显式设时间：排序断言不能依赖文件系统写入顺序
    os.utime(path, (mtime, mtime))


def test_list_files_classifies_and_sorts(tmp_path: Path) -> None:
    backups = tmp_path / "backups"
    touch(backups / "memories-20261108.db", 10, mtime=1_700_000_000)
    touch(backups / "memories-20261109.db", 20, mtime=1_700_100_000)
    touch(backups / "memories-before-memory-clear-20261109-120000.db", 30, mtime=1_700_200_000)
    touch(backups / "memories-replaced-20261109-130000.db", 40, mtime=1_700_300_000)
    touch(backups / "memories-rejected-20261109-140000.db", 50, mtime=1_700_400_000)
    touch(backups / "something-else.db", 60, mtime=1_700_500_000)

    entries = make_service(tmp_path).list_files()

    assert [entry.file for entry in entries] == [
        "something-else.db",
        "memories-rejected-20261109-140000.db",
        "memories-replaced-20261109-130000.db",
        "memories-before-memory-clear-20261109-120000.db",
        "memories-20261109.db",
        "memories-20261108.db",
    ]
    assert [entry.kind for entry in entries] == [
        "other",
        "rejected",
        "replaced",
        "before",
        "daily",
        "daily",
    ]


def test_list_files_skips_empty_and_missing_dir(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    assert service.list_files() == []  # 目录还不存在时不该抛

    touch(tmp_path / "backups" / "memories-20261109.db", 0, mtime=1_700_000_000)
    assert service.list_files() == []  # 0 字节是写坏的半成品，不给用户看


def test_backup_dir_property(tmp_path: Path) -> None:
    assert make_service(tmp_path).backup_dir == tmp_path / "backups"


async def test_snapshot_now_creates_before_file(tmp_path: Path) -> None:
    created = await make_service(tmp_path, store=FakeStore()).snapshot_now()

    assert created is not None
    assert created.name.startswith("memories-before-manual-")
    assert created.read_bytes() == b"sqlite-snapshot"


async def test_snapshot_now_without_store_returns_none(tmp_path: Path) -> None:
    assert await make_service(tmp_path).snapshot_now() is None


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    app = FastAPI()
    app.include_router(build_data_router(FakeExport(), FakeRestore(), make_service(tmp_path)))
    return TestClient(app)


def test_backups_route_lists_entries(client: TestClient, tmp_path: Path) -> None:
    touch(tmp_path / "backups" / "memories-20261109.db", 12, mtime=1_700_000_000)
    touch(tmp_path / "backups" / "memories-before-manual-20261109-130000.db", 34, mtime=1_700_100_000)

    body = client.get("/data/backups").json()

    assert body["dir"] == str(tmp_path / "backups")
    assert body["total_bytes"] == 46
    assert [entry["kind"] for entry in body["entries"]] == ["before", "daily"]
    assert set(body["entries"][0]) == {"file", "kind", "bytes", "modified_at"}


def test_backup_now_route_writes_snapshot(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(build_data_router(FakeExport(), FakeRestore(), make_service(tmp_path, store=FakeStore(payload=b"abc"))))

    body = TestClient(app).post("/data/backup").json()

    assert body["file"].startswith("memories-before-manual-")
    assert body["bytes"] == 3
    assert Path(body["path"]).read_bytes() == b"abc"


def test_backup_now_route_reports_failure_as_empty(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(
        build_data_router(FakeExport(), FakeRestore(), make_service(tmp_path, store=FakeStore(error=RuntimeError("disk full"))))
    )

    body = TestClient(app).post("/data/backup").json()

    assert body == {"path": "", "file": "", "bytes": 0}


def test_routes_without_backup_service_are_empty(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(build_data_router(FakeExport(), FakeRestore()))
    client = TestClient(app)

    assert client.get("/data/backups").json() == {"dir": "", "total_bytes": 0, "entries": []}
    assert client.post("/data/backup").json() == {"path": "", "file": "", "bytes": 0}
