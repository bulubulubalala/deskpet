"""文件职责：T0.4 边界错误处理的契约测试（DeskpetError → 500 信封 + 日志）。

依赖方向：api 层；用 FastAPI TestClient，不需要任何硬件（CODE_STYLE §7）。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from adapters.log_writer import RollingJsonLogHandler, setup_logging
from app import create_app
from contracts.errors import (
    CODE_INTERNAL,
    CODE_TTS_NOT_AVAILABLE,
    CODE_TTS_SYNTHESIS_FAILED,
)
from core.errors import TtsError
from core.logging import get_logger, log_event

LOG_NAME = "deskpet.log"


def _raise_tts_error() -> None:
    raise TtsError(
        CODE_TTS_SYNTHESIS_FAILED,
        "单句合成超时",
        user_hint="语音引擎异常",
        context={"sentence_index": 2},
    )


def _raise_unexpected_error() -> None:
    raise RuntimeError("内部细节不该出现在响应里")


def _client(route: Callable[[], None]) -> TestClient:
    app: FastAPI = create_app()
    app.get("/boom")(route)
    # raise_server_exceptions=False：Starlette 发完 500 响应后会继续抛，测试要拿响应而非异常
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture()
def log_file(tmp_path: Path) -> Iterator[Path]:
    path = tmp_path / LOG_NAME
    root = setup_logging(log_file=path, level="debug", max_bytes=1024 * 1024, retention_days=7)
    yield path
    for handler in list(root.handlers):
        if isinstance(handler, RollingJsonLogHandler):
            root.removeHandler(handler)
            handler.close()


def _last_record(path: Path) -> dict[str, object]:
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert lines, "应当写出至少一条日志"
    return lines[-1]


def test_deskpet_error_becomes_500_envelope_and_log_line(log_file: Path) -> None:
    response = _client(_raise_tts_error).get("/boom")
    body = response.json()
    assert response.status_code == 500
    assert body["code"] == CODE_TTS_SYNTHESIS_FAILED
    assert body["user_hint"] == "语音引擎异常"
    assert "trace" not in body  # 栈只在日志里
    record = _last_record(log_file)
    assert record["code"] == CODE_TTS_SYNTHESIS_FAILED
    assert record["domain"] == "TTS"
    assert record["path"] == "/boom"
    assert record["sentence_index"] == 2
    assert "TtsError" in str(record["trace"])


def test_unexpected_error_is_generic_500_without_leaking_details(log_file: Path) -> None:
    response = _client(_raise_unexpected_error).get("/boom")
    assert response.status_code == 500
    assert response.json()["code"] == CODE_INTERNAL
    assert response.json()["message"] == "sidecar 内部错误"
    assert "内部细节不该出现在响应里" not in response.text
    record = _last_record(log_file)
    assert record["event"] == "unhandled_error"
    assert record["code"] == CODE_INTERNAL
    assert "RuntimeError" in str(record["trace"])


def test_health_still_works_with_error_handlers_installed() -> None:
    """回归：装上统一处理器后，/health、501 桩与新实现的失败信封行为不变。

    T1.1 起桩路由声明了请求模型、参数校验先于 handler：合法入参得到 501，缺参数得到 422。
    M1 的桩路由现已全部落地（/gpu/lock 随 D18 取消，其余桩没有 JSON 请求体），所以 422
    改用已实现的 /chat/stream 验证——它同样声明了请求模型，参数校验同样先于 handler。
    T1.5 起 /tts 是真实现，没启动适配器时必须是 DP-TTS-503。
    """

    client = TestClient(create_app())
    assert client.get("/health").status_code == 200
    payload = {"char_id": "amber", "kind": "fact", "text": "probe"}
    stub = client.post("/memory/write", json=payload)
    assert stub.status_code == 501
    assert stub.json()["detail"]["code"] == "DP-SYS-501"
    assert client.post("/chat/stream", json={}).status_code == 422
    tts = client.post("/tts", json={"text": "你好", "voice_id": "amber", "request_id": "r1"})
    assert tts.status_code == 500
    assert tts.json()["code"] == CODE_TTS_NOT_AVAILABLE


def test_logging_without_handler_does_not_raise() -> None:
    """没有 setup_logging 时也不许因为写日志报错（纯逻辑层不依赖 handler）。"""

    log_event(get_logger("test"), logging.INFO, module="test", event="demo", message="无 handler")
