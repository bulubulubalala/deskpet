"""文件职责：T1.5 IndexTTS 常驻适配器客户端的契约测试（httpx.MockTransport，不联网）。

覆盖三条最贵的错误路径：引擎没启动（DP-TTS-503）、超时（DP-TTS-002）、引擎自己报错
（原样透传引擎侧的 code / message / hint，D14：本项目只调用、不运维）。
性能响应头（X-Deskpet-*）必须原样带出——T1.7 的首音指标与 docs/MEASURED.md 都从这里取数。
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from adapters.tts_index import IndexTtsClient, TtsEndpoint
from contracts.api_models import TtsRequest
from contracts.errors import (
    CODE_TTS_ADAPTER_ERROR,
    CODE_TTS_NOT_AVAILABLE,
    CODE_TTS_SENTENCE_TIMEOUT,
)
from core.errors import TtsError
from core.tts import CANCEL_IN_FLIGHT, CANCEL_QUEUED, CANCEL_UNKNOWN

BASE_URL = "http://127.0.0.1:8742"

Handler = Callable[[httpx.Request], httpx.Response]


def _client(handler: Handler, *, token: str = "") -> tuple[IndexTtsClient, list[httpx.Request]]:
    """把请求记下来再交给 handler，便于断言「到底发了什么」。"""
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    endpoint = TtsEndpoint(base_url=BASE_URL, token=token)
    return IndexTtsClient(endpoint, transport=httpx.MockTransport(wrapped)), seen


def _request(**overrides: object) -> TtsRequest:
    payload: dict[str, object] = {
        "text": "你好",
        "voice_id": "amber",
        "lang": "zh",
        "emo_vector": [0.0] * 8,
        "request_id": "r1",
    }
    payload.update(overrides)
    return TtsRequest(**payload)


async def test_synthesize_sends_contract_payload_and_reads_perf_headers() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tts"
        return httpx.Response(
            200,
            content=b"RIFF-fake-wav",
            headers={
                "X-Deskpet-Request-Id": "r1",
                "X-Deskpet-Gen-Ms": "1234",
                "X-Deskpet-Audio-Ms": "2500",
                "X-Deskpet-Rtf": "0.49",
                "X-Deskpet-Voice": "amber",
            },
        )

    client, seen = _client(handler)
    audio = await client.synthesize(_request(emo_vector=[0.5, 0.1, 0, 0, 0, 0, 0, 0.4]))

    assert audio.audio == b"RIFF-fake-wav"
    assert audio.request_id == "r1"
    assert audio.gen_ms == 1234
    assert audio.audio_ms == 2500
    assert audio.rtf == 0.49
    assert audio.voice == "amber"
    assert audio.duration_s == 2.5
    sent = json.loads(seen[0].content)
    assert sent["text"] == "你好"
    assert sent["voice"] == "amber"
    assert sent["lang"] == "ZH"  # 适配器只认大写语言码（§6.12）
    assert sent["emo_vector"] == [0.5, 0.1, 0, 0, 0, 0, 0, 0.4]
    assert sent["request_id"] == "r1"
    assert sent["timeout_s"] == 30.0


async def test_synthesize_without_perf_headers_falls_back_to_request_fields() -> None:
    """引擎没给性能头也不能崩：request_id / voice 回落到请求里的值，数字回落到 0。"""
    client, _seen = _client(lambda request: httpx.Response(200, content=b"x"))
    audio = await client.synthesize(_request(voice_id="snow", request_id="r2"))

    assert audio.request_id == "r2"
    assert audio.voice == "snow"
    assert (audio.gen_ms, audio.audio_ms, audio.rtf) == (0, 0, 0.0)


async def test_token_header_is_sent_only_when_configured() -> None:
    seen_headers: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(dict(request.headers))
        return httpx.Response(200, content=b"x")

    client, _ = _client(handler, token="secret")
    await client.synthesize(_request())
    client, _ = _client(handler)
    await client.synthesize(_request())

    assert seen_headers[0].get("x-deskpet-token") == "secret"
    assert "x-deskpet-token" not in seen_headers[1]


async def test_engine_down_maps_to_dp_tts_503() -> None:
    """引擎没启动：立刻报错并给出「自己启动适配器」的指引（D14，本项目不替用户拉起引擎）。"""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client, _ = _client(handler)
    with pytest.raises(TtsError) as excinfo:
        await client.synthesize(_request())

    assert excinfo.value.code == CODE_TTS_NOT_AVAILABLE
    assert excinfo.value.user_hint is not None
    assert "IndexTTS" in excinfo.value.user_hint


async def test_timeout_maps_to_dp_tts_002() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    client, _ = _client(handler)
    with pytest.raises(TtsError) as excinfo:
        await client.synthesize(_request())

    assert excinfo.value.code == CODE_TTS_SENTENCE_TIMEOUT


async def test_adapter_error_envelope_is_passed_through_verbatim() -> None:
    """D14：引擎侧的 code / message / hint 原样带出，本层只补 URL 与状态码。"""
    envelope = {
        "code": "DP-TTS-500",
        "message": "RuntimeError: CUDA out of memory",
        "hint": "查看 IndexTTS 侧日志；本应用不替用户安装、修复或重启引擎",
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json=envelope)

    client, _ = _client(handler)
    with pytest.raises(TtsError) as excinfo:
        await client.synthesize(_request())

    assert excinfo.value.code == "DP-TTS-500"
    assert "CUDA out of memory" in excinfo.value.message
    assert excinfo.value.user_hint == envelope["hint"]


async def test_foreign_error_code_is_wrapped_as_dp_tts_500() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"code": "E-42", "message": "boom"})

    client, _ = _client(handler)
    with pytest.raises(TtsError) as excinfo:
        await client.synthesize(_request())

    assert excinfo.value.code == CODE_TTS_ADAPTER_ERROR
    assert "E-42" in excinfo.value.message


async def test_non_json_error_body_reports_http_status() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>bad gateway</html>")

    client, _ = _client(handler)
    with pytest.raises(TtsError) as excinfo:
        await client.synthesize(_request())

    assert excinfo.value.code == CODE_TTS_ADAPTER_ERROR
    assert "502" in excinfo.value.message


@pytest.mark.parametrize("state", [CANCEL_QUEUED, CANCEL_IN_FLIGHT, CANCEL_UNKNOWN])
async def test_cancel_states_pass_through(state: str) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"cancelled": state})

    client, seen = _client(handler)
    assert await client.cancel("r9") == state
    assert json.loads(seen[0].content) == {"request_id": "r9"}


async def test_cancel_unknown_state_is_normalized() -> None:
    """适配器回了个没见过的词（或空体）时按 unknown 处理：调用方不该因此报错。"""
    client, _ = _client(lambda _r: httpx.Response(200, json={"cancelled": "who knows"}))

    assert await client.cancel("r9") == CANCEL_UNKNOWN


async def test_load_unload_and_health_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/load":
            return httpx.Response(200, json={"model_loaded": True, "load_ms": 17700})
        if request.url.path == "/unload":
            return httpx.Response(200, json={"model_loaded": False})
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "ready": True,
                "model_loaded": True,
                "load_ms": 17700,
                "sample_rate": 22050,
                "queue": {"pending": 2, "current": "r1"},
                "langs": ["ZH", "EN"],
            },
        )

    client, _ = _client(handler)
    assert await client.load() == 17700
    await client.unload()
    health = await client.health()

    assert health.ready is True
    assert health.model_loaded is True
    assert health.load_ms == 17700
    assert health.sample_rate == 22050
    assert health.queue_pending == 2
    assert health.queue_current == "r1"


async def test_health_without_queue_reports_idle() -> None:
    """适配器还没起来 / 回了个残缺体时不能抛：F9 要靠它判断「嗓子在不在」。"""
    client, _ = _client(lambda _r: httpx.Response(200, json={"status": "starting"}))

    health = await client.health()

    assert health.ready is False
    assert health.model_loaded is False
    assert health.queue_pending == 0
    assert health.queue_current is None
