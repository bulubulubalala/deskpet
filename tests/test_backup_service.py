"""每日记忆库快照（D9）：什么时候做、放哪里、留几份、失败怎么办。"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import pytest

from services.backup_service import MemoryBackupService


class FakeStore:
    """只实现快照写盘；真实 SqliteMemoryStore 的 VACUUM INTO 由集成测试覆盖。"""

    def __init__(self, *, payload: bytes = b"sqlite-snapshot", error: Exception | None = None) -> None:
        self.payload = payload
        self.error = error
        self.calls: list[Path] = []

    def backup_to(self, path: Path) -> None:
        self.calls.append(path)
        if self.error is not None:
            raise self.error
        path.write_bytes(self.payload)


def at(year: int, month: int, day: int) -> float:
    return datetime(year, month, day, 12, 0, 0).timestamp()  # noqa: DTZ001 - 测试只关心本机日期


def make_service(
    store: FakeStore | None, tmp_path: Path, *, keep: int = 7, now: float = None
) -> MemoryBackupService:  # type: ignore[assignment]
    return MemoryBackupService(
        store,
        tmp_path / "backups",
        keep=keep,
        now=lambda: at(2026, 11, 9) if now is None else now,
    )


async def test_writes_today_snapshot(tmp_path: Path) -> None:
    store = FakeStore()
    service = make_service(store, tmp_path)

    created = await service.run_once()

    assert created == tmp_path / "backups" / "memories-20261109.db"
    assert created is not None and created.read_bytes() == b"sqlite-snapshot"
    assert store.calls[0].suffix == ".tmp"  # 先写 tmp 再改名，避免半份快照被当成品


async def test_same_day_is_idempotent(tmp_path: Path) -> None:
    store = FakeStore()
    service = make_service(store, tmp_path)

    assert await service.run_once() is not None
    assert await service.run_once() is None
    assert len(store.calls) == 1


async def test_next_day_takes_another_snapshot(tmp_path: Path) -> None:
    store = FakeStore()
    first = make_service(store, tmp_path)
    await first.run_once()
    second = make_service(store, tmp_path, now=at(2026, 11, 10))

    assert await second.run_once() == tmp_path / "backups" / "memories-20261110.db"
    assert len(list((tmp_path / "backups").glob("memories-*.db"))) == 2


async def test_prunes_old_snapshots_by_date(tmp_path: Path) -> None:
    backups = tmp_path / "backups"
    backups.mkdir()
    for day in range(1, 9):
        (backups / f"memories-202611{day:02d}.db").write_bytes(b"old")
    store = FakeStore()
    service = make_service(store, tmp_path, keep=7)

    await service.run_once()

    names = sorted(p.name for p in backups.glob("memories-*.db"))
    assert len(names) == 7
    assert "memories-20261101.db" not in names  # 最老的一份被清掉
    assert "memories-20261109.db" in names


async def test_missing_store_is_silent(tmp_path: Path) -> None:
    service = make_service(None, tmp_path)

    assert await service.run_once() is None
    assert not (tmp_path / "backups").exists()
    await asyncio.wait_for(service.run_forever(), timeout=1.0)


async def test_failure_keeps_engine_alive(tmp_path: Path) -> None:
    store = FakeStore(error=RuntimeError("database is locked"))
    service = make_service(store, tmp_path)

    assert await service.run_once() is None
    assert list((tmp_path / "backups").glob("*")) == []  # tmp 也清掉了，不留垃圾
    # 第二天仍会重试，而不是从此放弃
    assert await make_service(FakeStore(), tmp_path, now=at(2026, 11, 10)).run_once() is not None

async def test_snapshot_before_writes_dated_file(tmp_path: Path) -> None:
    store = FakeStore()
    service = make_service(store, tmp_path)

    created = await service.snapshot_before("memory clear")

    assert created == tmp_path / "backups" / "memories-before-memory-clear-20261109-120000.db"
    assert created is not None and created.read_bytes() == b"sqlite-snapshot"
    assert store.calls[0].suffix == ".tmp"


async def test_snapshot_before_does_not_eat_daily_snapshots(tmp_path: Path) -> None:
    backups = tmp_path / "backups"
    backups.mkdir()
    for day in range(1, 8):
        (backups / f"memories-202611{day:02d}.db").write_bytes(b"old")
    service = make_service(FakeStore(), tmp_path, keep=7)

    await service.snapshot_before("memory-clear")

    daily = sorted(p.name for p in backups.glob("memories-202611*.db"))
    assert len(daily) == 7  # 留底不该把每日快照挤掉
    assert len(list(backups.glob("memories-before-*.db"))) == 1


async def test_snapshot_before_keeps_three_per_reason(tmp_path: Path) -> None:
    backups = tmp_path / "backups"
    noon = at(2026, 11, 9)
    for hour in (10, 11, 12, 13):
        service = make_service(FakeStore(), tmp_path, now=noon + (hour - 12) * 3600)
        assert await service.snapshot_before("memory-clear") is not None
    other = make_service(FakeStore(), tmp_path, now=at(2026, 11, 9))
    await other.snapshot_before("settings-reset")

    mine = sorted(p.name for p in backups.glob("memories-before-memory-clear-*.db"))
    assert mine == [
        "memories-before-memory-clear-20261109-110000.db",
        "memories-before-memory-clear-20261109-120000.db",
        "memories-before-memory-clear-20261109-130000.db",
    ]
    assert len(list(backups.glob("memories-before-settings-reset-*.db"))) == 1


async def test_snapshot_before_failure_is_silent(tmp_path: Path) -> None:
    service = make_service(FakeStore(error=RuntimeError("disk full")), tmp_path)

    assert await service.snapshot_before("memory-clear") is None
    assert list((tmp_path / "backups").glob("*")) == []


async def test_snapshot_before_without_store_does_nothing(tmp_path: Path) -> None:
    service = make_service(None, tmp_path)

    assert await service.snapshot_before("memory-clear") is None
    assert not (tmp_path / "backups").exists()
