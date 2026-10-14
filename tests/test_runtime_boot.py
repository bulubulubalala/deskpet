"""文件职责：T0.5 启动编排的契约测试（端口选择、runtime.json、回环 token、配置读取）。

为什么这些测试不需要硬件：全部落在 core/adapters 的纯逻辑与本地文件/端口上，
不加载任何模型、不碰 GPU、不碰麦克风（CODE_STYLE §7）。
"""

import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from adapters.runtime_file import read_runtime_file, remove_runtime_file, write_runtime_file
from adapters.socket_binding import bind_listening_socket
from api.auth import TOKEN_HEADER
from app import create_app
from config import DEFAULT_HOST, DEFAULT_PORT, load_settings
from contracts.errors import CODE_UNAUTHORIZED
from contracts.routes import SERVICE_VERSION
from contracts.runtime import RuntimeInfo

TOKEN = "a" * 64


def _free_port() -> int:
    """借系统分配一个空闲端口再立刻释放，用来当「首选端口」的样本。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((DEFAULT_HOST, 0))
        return int(probe.getsockname()[1])


def _sample_info(port: int) -> RuntimeInfo:
    return RuntimeInfo(
        pid=4242,
        host=DEFAULT_HOST,
        port=port,
        token=TOKEN,
        started_at="2026-10-14T00:00:00+00:00",
        version=SERVICE_VERSION,
    )


def test_bind_listening_socket_keeps_preferred_port_when_free() -> None:
    port = _free_port()
    sock, actual_port = bind_listening_socket(DEFAULT_HOST, port)
    try:
        assert actual_port == port
    finally:
        sock.close()


def test_bind_listening_socket_falls_back_when_port_taken() -> None:
    port = _free_port()
    holder, holder_port = bind_listening_socket(DEFAULT_HOST, port)
    try:
        sock, actual_port = bind_listening_socket(DEFAULT_HOST, port)
        try:
            assert actual_port != holder_port
            assert actual_port > 0
        finally:
            sock.close()
    finally:
        holder.close()


def test_runtime_file_roundtrip_is_atomic(tmp_path: Path) -> None:
    target = tmp_path / "data" / "runtime.json"
    info = _sample_info(8737)
    write_runtime_file(target, info)
    assert read_runtime_file(target) == info
    # 目录要自动建出来，且不能留下半截临时文件（Electron 只会看到最终文件）
    assert target.parent.is_dir()
    assert [p.name for p in target.parent.iterdir()] == ["runtime.json"]


def test_remove_runtime_file_is_idempotent(tmp_path: Path) -> None:
    target = tmp_path / "runtime.json"
    write_runtime_file(target, _sample_info(8737))
    remove_runtime_file(target)
    assert not target.exists()
    remove_runtime_file(target)  # 再删一次不该抛（崩溃重启后的清理路径）


def test_token_middleware_rejects_missing_or_wrong_token() -> None:
    client = TestClient(create_app(token=TOKEN))
    missing = client.get("/health")
    assert missing.status_code == 401
    assert missing.json()["code"] == CODE_UNAUTHORIZED
    wrong = client.get("/health", headers={TOKEN_HEADER: "b" * 64})
    assert wrong.status_code == 401


def test_token_middleware_accepts_matching_token() -> None:
    client = TestClient(create_app(token=TOKEN))
    response = client.get("/health", headers={TOKEN_HEADER: TOKEN})
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_app_without_token_stays_open_for_tests() -> None:
    """不传 token = 不做校验：单测与本地 /docs 调试都走这条路。"""
    assert TestClient(create_app()).get("/health").status_code == 200


def test_load_settings_defaults_match_env_example() -> None:
    settings = load_settings({})
    assert settings.host == DEFAULT_HOST == "127.0.0.1"
    assert settings.port == DEFAULT_PORT == 8737
    assert settings.log_level == "info"
    assert settings.runtime_file.name == "runtime.json"


def test_load_settings_reads_env_overrides() -> None:
    settings = load_settings(
        {
            "DESKPET_SIDECAR_HOST": "127.0.0.1",
            "DESKPET_SIDECAR_PORT": "9001",
            "DESKPET_DATA_DIR": "C:/deskpet-data",
            "DESKPET_LOG_LEVEL": "DEBUG",
        }
    )
    assert settings.port == 9001
    assert settings.data_dir == Path("C:/deskpet-data")
    assert settings.runtime_file == Path("C:/deskpet-data/runtime.json")
    assert settings.log_level == "debug"


@pytest.mark.parametrize("raw_port", ["abc", "70000", "-1"])
def test_load_settings_rejects_invalid_port(raw_port: str) -> None:
    with pytest.raises(ValueError):
        load_settings({"DESKPET_SIDECAR_PORT": raw_port})
