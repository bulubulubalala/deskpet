r"""文件职责：IndexTTS 适配器的纯逻辑测试（排队 / 取消 / HTTP 信封 / 参数校验）。

为什么不需要 IndexTTS 和 torch：全部用例用 FakeEngine 顶替模型，只验证最容易出竞态的两块——
队列与取消语义、路由与错误码（CODE_STYLE §7：核心逻辑必须能在无 GPU 的机器上跑）。

运行：仓库根 ./.venv/Scripts/python.exe -m pytest tests/test_indextts_adapter.py
"""

from __future__ import annotations

import http.client
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from typing import Any

import pytest

from tools.indextts_adapter.config import MAX_QUEUE
from tools.indextts_adapter.engine import IndexTtsEngine
from tools.indextts_adapter.errors import AdapterError
from tools.indextts_adapter.http_api import AdapterState, make_handler
from tools.indextts_adapter.worker import SynthesisRequest, TtsWorker


class FakeEngine:
    """假引擎：实现 worker 需要的接口，不碰 torch / soundfile。"""

    def __init__(self, gate: threading.Event | None = None, error: Exception | None = None) -> None:
        self.loaded = False
        self.load_ms: int | None = None
        self.sample_rate = 24000
        self.calls: list[str] = []
        self._gate = gate
        self._error = error

    def load(self) -> None:
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    def synth(self, req: Any) -> tuple[bytes, dict[str, Any]]:
        self.calls.append(req.request_id)
        if self._gate is not None:
            assert self._gate.wait(timeout=5), "gate 没被放行，测试自己挂了"
        if self._error is not None:
            raise self._error
        return b"RIFFfake", {"gen_ms": 5, "audio_ms": 100, "rtf": 0.05, "voice": "fake"}


def make_request(request_id: str = "r1", **overrides: Any) -> SynthesisRequest:
    fields: dict[str, Any] = {
        "text": "你好",
        "voice": "xiaoxue",
        "lang": "ZH",
        "emo_vector": None,
        "target_peak": 0.0,
    }
    fields.update(overrides)
    return SynthesisRequest(request_id, **fields)


def start_worker(engine: Any) -> TtsWorker:
    worker = TtsWorker(engine)
    worker.start()
    return worker


def wait_until(predicate: Any, timeout: float = 5.0) -> None:
    """轮询等待某个条件成立（比 sleep 固定时长稳）。"""
    deadline = threading.Event()
    waited = 0.0
    while not predicate():
        if deadline.wait(0.01) or (waited := waited + 0.01) > timeout:
            raise AssertionError("等待超时")


# ---------- 参考音解析 ----------


def test_resolve_voice_accepts_name_suffix_and_absolute_path(tmp_path: Any) -> None:
    wav = tmp_path / "xiaoxue.wav"
    wav.write_bytes(b"ri")
    engine = IndexTtsEngine(tmp_path, tmp_path)
    assert engine.resolve_voice("xiaoxue") == wav
    assert engine.resolve_voice("xiaoxue.wav") == wav
    assert engine.resolve_voice(str(wav)) == wav


def test_resolve_voice_rejects_missing_without_guessing(tmp_path: Any) -> None:
    engine = IndexTtsEngine(tmp_path, tmp_path)
    with pytest.raises(AdapterError) as excinfo:
        engine.resolve_voice("someone-else")
    assert excinfo.value.code == "DP-TTS-400"
    assert excinfo.value.hint


# ---------- 队列与取消 ----------


def test_worker_finishes_request_and_reports_meta() -> None:
    engine = FakeEngine()
    worker = start_worker(engine)
    req = make_request()
    worker.submit(req)
    assert req.done.wait(timeout=5)
    assert req.state == "done"
    assert req.audio == b"RIFFfake"
    assert req.meta["audio_ms"] == 100
    worker.stop()


def test_worker_passes_adapter_error_through() -> None:
    worker = start_worker(FakeEngine(error=AdapterError("DP-TTS-503", "模型不可用")))
    req = make_request()
    worker.submit(req)
    assert req.done.wait(timeout=5)
    assert req.state == "failed"
    assert req.error is not None and req.error.code == "DP-TTS-503"
    worker.stop()


def test_worker_wraps_engine_crash_as_500() -> None:
    """引擎内部异常原样带出类型与消息，但不猜原因（D14）。"""
    worker = start_worker(FakeEngine(error=RuntimeError("boom")))
    req = make_request()
    worker.submit(req)
    assert req.done.wait(timeout=5)
    assert req.error is not None
    assert req.error.code == "DP-TTS-500"
    assert "RuntimeError: boom" in req.error.message
    worker.stop()


def test_cancel_queued_request_drops_it() -> None:
    gate = threading.Event()
    engine = FakeEngine(gate=gate)
    worker = start_worker(engine)
    first = make_request("r1")
    worker.submit(first)
    wait_until(lambda: engine.calls == ["r1"])
    second = make_request("r2")
    worker.submit(second)
    assert worker.cancel("r2") == "queued"
    assert second.done.wait(timeout=5)
    assert second.error is not None and second.error.code == "DP-TTS-499"
    gate.set()
    assert first.done.wait(timeout=5)
    assert engine.calls == ["r1"], "被取消的排队句不该被送进引擎"
    worker.stop()


def test_cancel_in_flight_only_marks_it() -> None:
    """在途句只能标记：IndexTTS 的 infer() 没有取消钩子，结果由播放侧丢弃（需求 §6.12）。"""
    gate = threading.Event()
    engine = FakeEngine(gate=gate)
    worker = start_worker(engine)
    req = make_request("r1")
    worker.submit(req)
    wait_until(lambda: engine.calls == ["r1"])
    assert worker.cancel("r1") == "in_flight"
    assert req.state == "cancelling"
    gate.set()
    assert req.done.wait(timeout=5)
    assert req.audio == b"RIFFfake", "在途句会算完，调用方拿到结果后自己丢"
    worker.stop()


def test_cancel_unknown_request_id() -> None:
    worker = start_worker(FakeEngine())
    assert worker.cancel("nope") == "unknown"
    worker.stop()


def test_queue_full_is_rejected_fast() -> None:
    """队列满要立刻报 409，绝不能让 HTTP 线程跟着一起等。"""
    worker = TtsWorker(FakeEngine())  # 刻意不 start()：没人消费，队列必然堵满
    for index in range(MAX_QUEUE):
        worker.submit(make_request(f"r{index}"))
    with pytest.raises(AdapterError) as excinfo:
        worker.submit(make_request("overflow"))
    assert excinfo.value.code == "DP-TTS-409"


# ---------- HTTP 边界 ----------


@contextmanager
def running_server(engine: FakeEngine, token: str = "") -> Iterator[str]:
    """真起一个 HTTP 服务（端口 0 让内核分配），测完关掉。"""
    worker = start_worker(engine)
    state = AdapterState(engine, worker, token)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        worker.stop()


def call(
    address: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes, Any]:
    conn = http.client.HTTPConnection(address, timeout=5)
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    conn.request(
        method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})}
    )
    response = conn.getresponse()
    data = response.read()
    result = (response.status, data, response)
    conn.close()
    return result


def test_health_never_loads_the_model() -> None:
    engine = FakeEngine()
    with running_server(engine) as address:
        status, data, response = call(address, "GET", "/health")
    assert status == 200
    assert response.getheader("Content-Type", "").startswith("application/json")
    payload = json.loads(data.decode("utf-8"))
    assert payload["ready"] is False
    assert payload["queue"] == {"pending": 0, "current": None}
    assert payload["langs"][0] == "ZH"
    assert engine.loaded is False, "/health 绝不能顺手把模型拉起来"


def test_tts_returns_wav_with_meta_headers() -> None:
    engine = FakeEngine()
    body = {"text": "你好呀", "voice": "xiaoxue", "lang": "ZH", "request_id": "r1"}
    with running_server(engine) as address:
        status, data, response = call(address, "POST", "/tts", body)
    assert status == 200
    assert data == b"RIFFfake"
    assert response.getheader("Content-Type") == "audio/wav"
    assert response.getheader("X-Deskpet-Request-Id") == "r1"
    assert response.getheader("X-Deskpet-Audio-Ms") == "100"
    assert engine.calls == ["r1"]


def test_tts_rejects_too_long_text_with_hint() -> None:
    with running_server(FakeEngine()) as address:
        status, data, _ = call(address, "POST", "/tts", {"text": "字" * 41, "voice": "v"})
    payload = json.loads(data.decode("utf-8"))
    assert status == 400
    assert payload["code"] == "DP-TTS-400"
    assert "40" in payload["message"]
    assert payload["hint"], "超长要告诉调用方先切句，否则它不知道该改哪儿"


def test_tts_rejects_empty_text_and_bad_emotion_vector() -> None:
    with running_server(FakeEngine()) as address:
        status_empty, data_empty, _ = call(address, "POST", "/tts", {"text": "   ", "voice": "v"})
        status_emo, data_emo, _ = call(
            address, "POST", "/tts", {"text": "你好", "voice": "v", "emo_vector": [0.1, 0.2]}
        )
    assert status_empty == 400 and json.loads(data_empty.decode())["code"] == "DP-TTS-400"
    assert status_emo == 400 and json.loads(data_emo.decode())["code"] == "DP-TTS-400"


def test_token_is_enforced_only_when_configured() -> None:
    with running_server(FakeEngine(), token="s3cret") as address:
        denied, denied_data, _ = call(address, "POST", "/cancel", {"request_id": "r1"})
        allowed, allowed_data, _ = call(
            address, "POST", "/cancel", {"request_id": "r1"}, {"X-Deskpet-Token": "s3cret"}
        )
    assert denied == 401
    assert json.loads(denied_data.decode())["code"] == "DP-TTS-401"
    assert allowed == 200
    assert json.loads(allowed_data.decode())["cancelled"] == "unknown"


def test_unknown_path_is_404_on_both_methods() -> None:
    with running_server(FakeEngine()) as address:
        get_status, _, _ = call(address, "GET", "/nope")
        post_status, _, _ = call(address, "POST", "/nope", {"x": 1})
    assert get_status == 404
    assert post_status == 404
