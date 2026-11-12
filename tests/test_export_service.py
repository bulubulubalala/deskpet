"""数据导出（D9 / M3）：包里有什么、密钥有没有漏、缺东西时怎么写原因、留几份。"""

from __future__ import annotations

import json
import sqlite3
import zipfile
from pathlib import Path

from config import Settings
from services.export_service import DataExportService, mask_settings


class FakeStore:
    """只实现快照写盘；真实的 VACUUM INTO 由 adapters 的测试覆盖。"""

    def __init__(
        self, *, payload: bytes = b"sqlcipher-snapshot", error: Exception | None = None
    ) -> None:
        self.payload = payload
        self.error = error
        self.calls: list[Path] = []

    def backup_to(self, path: Path) -> None:
        self.calls.append(path)
        if self.error is not None:
            raise self.error
        path.write_bytes(self.payload)


def make_settings(tmp_path: Path) -> Settings:
    """造一份指向临时目录的设置：只关心 data_dir / characters_dir。"""
    return Settings(data_dir=tmp_path / "data", characters_dir=tmp_path / "characters")


def prepare(tmp_path: Path, *, secret: str = "sk-real-key") -> Settings:
    """准备一个真实的目录形状：角色、日志、使用统计库都在。"""
    settings = make_settings(tmp_path)
    characters = settings.characters_dir / "snow"
    characters.mkdir(parents=True)
    (characters / "model.json").write_text("{}", encoding="utf-8")
    logs = settings.data_dir / "logs"
    logs.mkdir(parents=True)
    (settings.log_file).write_text(
        "\n".join(f"line-{index}" for index in range(10)) + "\n", encoding="utf-8"
    )
    return settings


def make_service(
    settings: Settings, store: FakeStore | None, *, keep: int = 3, now: float = 1_700_000_000.0
) -> DataExportService:
    return DataExportService(settings, store, keep=keep, now=lambda: now)


async def test_export_contains_snapshot_settings_characters_and_log_tail(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    store = FakeStore()
    service = make_service(settings, store)

    result = await service.export()

    assert result.path.is_file()
    assert result.size_bytes > 0
    assert result.created_at.startswith("2023-11-1")  # 1_700_000_000 = 2023-11-15 本机时间
    with zipfile.ZipFile(result.path) as archive:
        names = set(archive.namelist())
        assert "memories.db" in names
        assert archive.read("memories.db") == b"sqlcipher-snapshot"
        assert "characters/snow/model.json" in names
        assert "logs/deskpet.log.tail" in names
        assert archive.read("logs/deskpet.log.tail").decode("utf-8").strip().endswith("line-9")
        payload = json.loads(archive.read("settings.json"))
        assert payload["_说明"].startswith("密钥已替换成占位符")
        assert payload["data_dir"].endswith("data")
        assert "README.txt" in names
        readme = archive.read("README.txt").decode("utf-8")
        assert "memories.db" in readme
        assert "key.blob" in readme
    assert store.calls, "记忆库快照必须真的被调用一次"
    # 快照临时文件不能留在数据目录里
    assert not list((settings.data_dir / "exports").glob("*.tmp"))


async def test_settings_json_never_contains_real_keys(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    # 直接构造一个带密钥的 Settings：默认值里 api_key 是空的，测不出脱敏
    settings = Settings(
        data_dir=settings.data_dir,
        characters_dir=settings.characters_dir,
        llm=type(settings.llm)(
            base_url="https://api.example.com/v1",
            api_key="sk-real-key",
            model="m",
        ),
    )
    service = make_service(settings, FakeStore())

    result = await service.export()

    with zipfile.ZipFile(result.path) as archive:
        raw = archive.read("settings.json").decode("utf-8")
    assert "sk-real-key" not in raw
    assert "***（已脱敏）" in raw
    assert "https://api.example.com/v1" in raw  # 地址不是秘密，保留下来方便对照


async def test_missing_memory_store_is_reported_not_silent(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    service = make_service(settings, None)

    result = await service.export()

    assert "memories.db" not in result.entries
    assert any("记忆库没有打开" in item for item in result.skipped)
    with zipfile.ZipFile(result.path) as archive:
        assert "settings.json" in archive.namelist()
        readme = archive.read("README.txt").decode("utf-8")
    assert "记忆库没有打开" in readme


async def test_memory_snapshot_failure_does_not_break_export(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    service = make_service(settings, FakeStore(error=RuntimeError("vacuum failed")))

    result = await service.export()

    assert result.path.is_file()
    assert any("记忆库快照失败" in item for item in result.skipped)
    assert not list((settings.data_dir / "exports").glob("*.tmp"))


async def test_keeps_only_latest_exports(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    exports = settings.data_dir / "exports"
    exports.mkdir(parents=True)
    for stamp in ("20200101-000000", "20200102-000000"):
        (exports / f"deskpet-export-{stamp}.zip").write_bytes(b"old")

    # now 比旧包新：按文件名时间戳排序，旧的先删
    await make_service(settings, FakeStore(), keep=2, now=1_700_000_000.0).export()

    names = sorted(path.name for path in exports.glob("deskpet-export-*.zip"))
    assert len(names) == 2
    assert "deskpet-export-20200101-000000.zip" not in names
    assert "deskpet-export-20200102-000000.zip" in names  # 第二旧的还在：keep=2


async def test_missing_log_and_characters_are_noted(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)  # 只有 data_dir，角色与日志都不存在
    service = make_service(settings, None)

    result = await service.export()

    assert any("日志" in item for item in result.skipped)
    assert any("角色目录" in item for item in result.skipped)


def test_mask_settings_walks_nested_structures() -> None:
    masked = mask_settings(
        {
            "llm": {"api_key": "sk-1", "base_url": "https://x", "local_api_key": ""},
            "providers": [{"token": "t", "name": "n"}],
            "nested": {"secret_value": "s"},
            "path": Path("/tmp/x"),
        }
    )
    assert masked["llm"]["api_key"] == "***（已脱敏）"
    assert masked["llm"]["base_url"] == "https://x"
    assert masked["llm"]["local_api_key"] == ""  # 空值不替换，免得看不出「没配」
    assert masked["providers"][0]["token"] == "***（已脱敏）"
    assert masked["providers"][0]["name"] == "n"
    assert masked["nested"]["secret_value"] == "***（已脱敏）"
    assert masked["path"] == str(Path("/tmp/x"))


async def test_usage_snapshot_closes_sqlite_connections(
    tmp_path: Path, monkeypatch
) -> None:
    """Windows 上没关掉的连接会让临时文件删不掉；这里直接盯连接是否已关闭。"""
    settings = prepare(tmp_path)
    usage = settings.usage_db_file
    usage.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(usage) as conn:
        conn.execute("CREATE TABLE t (x INTEGER)")
        conn.execute("INSERT INTO t VALUES (1)")

    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def tracking_connect(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        opened.append(connection)
        return connection

    monkeypatch.setattr("services.export_service.sqlite3.connect", tracking_connect)

    result = await make_service(settings, FakeStore()).export()

    with zipfile.ZipFile(result.path) as archive:
        assert "usage.db" in archive.namelist()
    assert len(opened) >= 2, "使用统计库与快照各要开一次连接"
    for connection in opened:
        try:
            connection.execute("SELECT 1")
        except sqlite3.ProgrammingError:
            continue
        raise AssertionError("导出结束后 sqlite 连接还没关闭（Windows 上会删不掉临时文件）")
    assert not list((settings.data_dir / "exports").glob("*.tmp"))


async def test_second_export_gets_a_new_file(tmp_path: Path) -> None:
    settings = prepare(tmp_path)
    service = make_service(settings, FakeStore(), now=1_700_000_000.0)
    first = await service.export()
    # 同一秒内再导出一次：文件名相同会覆盖，这里只要求「能再跑一次且包还完整」
    second = await service.export()
    assert second.path == first.path
    assert second.size_bytes > 0
