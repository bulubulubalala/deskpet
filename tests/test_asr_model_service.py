"""语音识别模型预下载（D7）：状态判定、单飞、进度、失败怎么说。

全部用假适配器 + 临时目录：不联网、不加载真模型，测的是「状态机与文案」。
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.asr import build_asr_router
from config import PROVIDER_CLOUD, PROVIDER_LOCAL, Settings
from core.errors import AsrError
from services.asr_model_service import AsrModelService


def make_service(
    tmp_path: Path,
    *,
    loader: object = None,
    provider: str = PROVIDER_LOCAL,
    model: str = "small",
    poll_interval_s: float = 0.01,
) -> AsrModelService:
    """造一份只关心模型目录的服务；loader 决定「下载」要多快、会不会失败。"""
    asr = replace(
        Settings(data_dir=tmp_path / "data", characters_dir=tmp_path / "chars").asr,
        model=model,
        model_dir=tmp_path / "models" / "asr",
        provider=provider,
    )
    return AsrModelService(asr, object(), loader=loader, poll_interval_s=poll_interval_s)


def test_missing_when_directory_is_empty(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    state = service.status()

    assert state.status == "missing"
    assert state.estimated_bytes == 488_000_000  # small 的量级，只用来显示进度
    assert "约 488 MB" in state.message
    assert state.user_hint


def test_cloud_provider_never_downloads(tmp_path: Path) -> None:
    service = make_service(tmp_path, provider=PROVIDER_CLOUD, loader=lambda: None)

    state = service.start()

    assert state.status == "ready"
    assert "云端" in state.message


def test_prefetch_writes_marker_and_becomes_ready(tmp_path: Path) -> None:
    calls: list[int] = []

    def loader() -> None:
        calls.append(1)
        target = tmp_path / "models" / "asr" / "small" / "model.bin"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x" * 1024)

    service = make_service(tmp_path, loader=loader)

    async def scenario() -> None:
        assert service.start().status == "downloading"
        await service.wait()

    asyncio.run(scenario())

    state = service.status()
    assert state.status == "ready"
    assert state.progress == 1.0
    assert calls == [1]
    assert (tmp_path / "models" / "asr" / ".deskpet-ready").read_text(encoding="utf-8") == "small"


def test_second_start_does_not_download_twice(tmp_path: Path) -> None:
    gate = threading.Event()
    calls: list[int] = []

    def loader() -> None:
        calls.append(1)
        gate.wait(timeout=2)

    service = make_service(tmp_path, loader=loader)

    async def scenario() -> None:
        service.start()
        second = service.start()
        assert second.status == "downloading"
        gate.set()
        await service.wait()
        assert service.status().status == "ready"

    asyncio.run(scenario())
    assert calls == [1]


def test_progress_comes_from_directory_size(tmp_path: Path) -> None:
    gate = threading.Event()

    def loader() -> None:
        target = tmp_path / "models" / "asr" / "small" / "model.bin"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x" * 122_000_000)  # 约 1/4 of small
        gate.wait(timeout=2)

    service = make_service(tmp_path, loader=loader)

    async def scenario() -> None:
        service.start()
        for _ in range(200):
            state = service.status()
            if state.downloaded_bytes > 0:
                break
            await asyncio.sleep(0.01)
        assert state.status == "downloading"
        assert state.downloaded_bytes > 0
        assert 0.0 < state.progress <= 0.99
        gate.set()
        await service.wait()

    asyncio.run(scenario())


def test_failure_is_reported_with_hint(tmp_path: Path) -> None:
    def loader() -> None:
        raise AsrError("DP-ASR-004", "模型下载中断", user_hint="检查网络后重试")

    service = make_service(tmp_path, loader=loader)

    async def scenario() -> None:
        service.start()
        await service.wait()

    asyncio.run(scenario())

    state = service.status()
    assert state.status == "error"
    assert "模型下载中断" in state.message
    assert state.user_hint == "检查网络后重试"


def test_existing_bin_counts_as_ready(tmp_path: Path) -> None:
    cached = tmp_path / "models" / "asr" / "small" / "model.bin"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"x" * 16)

    service = make_service(tmp_path)

    assert service.status().status == "ready"


def test_unknown_model_name_reports_no_percentage(tmp_path: Path) -> None:
    service = make_service(tmp_path, model="my-custom-whisper")

    state = service.status()

    assert state.estimated_bytes == 0
    assert "约" not in state.message


def test_routes_expose_status_and_prefetch(tmp_path: Path) -> None:
    """两个端点只做「转发到 service」，用真 FastAPI 跑一遍确认形状。"""
    calls: list[int] = []

    def loader() -> None:
        calls.append(1)
        (tmp_path / "models" / "asr" / "small").mkdir(parents=True, exist_ok=True)
        (tmp_path / "models" / "asr" / "small" / "model.bin").write_bytes(b"x")

    service = make_service(tmp_path, loader=loader)
    app = FastAPI()
    app.include_router(build_asr_router(None, None, service))  # type: ignore[arg-type]

    with TestClient(app) as client:
        first = client.get("/asr/model")
        assert first.status_code == 200
        assert first.json()["status"] == "missing"

        started = client.post("/asr/model/prefetch")
        assert started.status_code == 200
        assert started.json()["status"] in {"downloading", "ready"}

        for _ in range(100):
            body = client.get("/asr/model").json()
            if body["status"] == "ready":
                break
            threading.Event().wait(0.02)
        assert body["status"] == "ready"

    assert calls == [1]


@pytest.mark.parametrize("model", ["small.en", "Systran/faster-whisper-small"])
def test_model_name_variants_share_estimate(tmp_path: Path, model: str) -> None:
    service = make_service(tmp_path, model=model)

    assert service.status().estimated_bytes == 488_000_000
