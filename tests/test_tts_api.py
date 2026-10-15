"""文件职责：POST /tts 与 POST /tts/cancel 的 HTTP 契约测试（真实 service + 假适配器）。

依赖方向：tests -> app（组合根）+ services（真实用例层）+ FastAPI TestClient + 假适配器。
谁调用：pytest。

关键约定：/tts 的 200 是二进制 wav（不是 JSON），引擎侧性能数字走响应头；
失败一律是失败信封（§6.4），前端据此决定「跳过这一句还是提示用户动手」。
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi.testclient import TestClient

from app import create_app
from contracts.api_models import TtsCancelResponse
from contracts.errors import CODE_TTS_SENTENCE_TIMEOUT, CODE_UNAUTHORIZED
from core.errors import TtsError
from core.tts import CANCEL_IN_FLIGHT, CANCEL_QUEUED, TtsAudio
from services.tts_service import TtsService

TOKEN = "test-token"
WAV = b"RIFF-fake-wav-bytes"


class FakeAdapter:
    """假适配器：不碰真引擎；可以装成超时或抛错。"""

    def __init__(
        self,
        *,
        voice: str = "amber",
        request_id: str = "r1",
        gen_ms: int = 1234,
        audio_ms: int = 2500,
        rtf: float = 0.49,
        error: TtsError | None = None,
        cancel_state: str = CANCEL_QUEUED,
    ) -> None:
        self.voice = voice
        self.request_id = request_id
        self.gen_ms = gen_ms
        self.audio_ms = audio_ms
        self.rtf = rtf
        self.error = error
        self.cancel_state = cancel_state
        self.texts: list[str] = []

    async def synthesize(self, request: object) -> TtsAudio:
        self.texts.append(getattr(request, "text"))
        if self.error is not None:
            raise self.error
        return TtsAudio(
            audio=WAV,
            request_id=self.request_id,
            gen_ms=self.gen_ms,
            audio_ms=self.audio_ms,
            rtf=self.rtf,
            voice=self.voice,
        )

    async def cancel(self, request_id: str) -> str:
        return self.cancel_state


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "text": "你好",
        "voice_id": "amber",
        "lang": "zh",
        "emo_vector": [0.0] * 8,
        "request_id": "r1",
    }
    payload.update(overrides)
    return payload


def _client(adapter: FakeAdapter, *, timeout_s: float = 30.0, token: str | None = None) -> TestClient:
    return TestClient(create_app(tts_service=TtsService(adapter, timeout_s=timeout_s), token=token))


def test_synthesize_returns_wav_bytes_with_perf_headers() -> None:
    adapter = FakeAdapter()
    response = _client(adapter).post("/tts", json=_payload())

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content == WAV
    assert response.headers["x-deskpet-request-id"] == "r1"
    assert response.headers["x-deskpet-gen-ms"] == "1234"
    assert response.headers["x-deskpet-audio-ms"] == "2500"
    assert response.headers["x-deskpet-rtf"] == "0.49"
    assert response.headers["x-deskpet-voice"] == "amber"
    assert adapter.texts == ["你好"]


def test_non_ascii_voice_is_percent_encoded_in_header() -> None:
    """Windows 上角色可以有中文音色名；HTTP 头只允许 latin-1，必须编码而不是崩掉。"""
    adapter = FakeAdapter(voice="琥珀")
    response = _client(adapter).post("/tts", json=_payload())

    assert response.status_code == 200
    value = response.headers["x-deskpet-voice"]
    assert value.isascii()
    assert value == quote("琥珀", safe="")


def test_missing_text_is_422() -> None:
    payload = _payload()
    payload.pop("text")
    assert _client(FakeAdapter()).post("/tts", json=payload).status_code == 422


def test_truly_empty_text_is_422() -> None:
    """空串连契约层都过不去（min_length=1），根本到不了用例层。"""
    response = _client(FakeAdapter()).post("/tts", json=_payload(text=""))

    assert response.status_code == 422


def test_empty_text_is_rejected_by_the_service() -> None:
    """pydantic 只挡 min_length=1，全空白由用例层兜住（DP-TTS-400）。"""
    response = _client(FakeAdapter()).post("/tts", json=_payload(text="   "))

    assert response.status_code == 500
    assert response.json()["code"] == "DP-TTS-400"


def test_sentence_timeout_returns_error_envelope() -> None:
    adapter = FakeAdapter(error=TtsError(CODE_TTS_SENTENCE_TIMEOUT, "等太久", user_hint="先跳过"))
    response = _client(adapter).post("/tts", json=_payload())

    assert response.status_code == 500
    body = response.json()
    assert body["code"] == CODE_TTS_SENTENCE_TIMEOUT
    assert body["user_hint"] == "先跳过"


def test_missing_token_is_unauthorized() -> None:
    adapter = FakeAdapter()
    response = _client(adapter, token=TOKEN).post("/tts", json=_payload())

    assert response.status_code == 401
    assert response.json()["code"] == CODE_UNAUTHORIZED
    assert adapter.texts == []


def test_cancel_returns_state_and_effectiveness() -> None:
    response = _client(FakeAdapter(cancel_state=CANCEL_IN_FLIGHT)).post(
        "/tts/cancel", json={"request_id": "r1"}
    )

    assert response.status_code == 200
    body = TtsCancelResponse.model_validate(response.json())
    assert body.cancelled is True
    assert body.reason == CANCEL_IN_FLIGHT


def test_cancel_missing_request_id_is_422() -> None:
    assert _client(FakeAdapter()).post("/tts/cancel", json={}).status_code == 422
