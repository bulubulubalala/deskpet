"""文件职责：T1.5 用例层测试——单句长度校验、单句超时、取消语义（纯假适配器，无网络无硬件）。

需求依据：§6.2 / §6.12 单句 ≤40 字；§6.7 单句超时 30s（超时只跳过这一句）；
§6.12 取消语义 queued / in_flight / unknown。
"""

from __future__ import annotations

import asyncio

import pytest

from config import load_settings
from contracts.api_models import TtsRequest
from contracts.errors import (
    CODE_TTS_ADAPTER_ERROR,
    CODE_TTS_BAD_REQUEST,
    CODE_TTS_SENTENCE_TIMEOUT,
)
from core.errors import TtsError
from core.tts import CANCEL_IN_FLIGHT, CANCEL_QUEUED, CANCEL_UNKNOWN, TtsAudio
from services.tts_service import TtsService, build_tts_service


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


def _audio(request_id: str = "r1", voice: str = "amber") -> TtsAudio:
    return TtsAudio(
        audio=b"RIFF",
        request_id=request_id,
        gen_ms=1000,
        audio_ms=2000,
        rtf=0.5,
        voice=voice,
    )


class FakeAdapter:
    """假适配器：可以指定返回、指定抛错、指定延迟，并记下收到的请求。"""

    def __init__(
        self,
        *,
        audio: TtsAudio | None = None,
        error: TtsError | None = None,
        delay_s: float = 0.0,
        cancel_state: str = CANCEL_QUEUED,
    ) -> None:
        self._audio = audio or _audio()
        self._error = error
        self._delay_s = delay_s
        self._cancel_state = cancel_state
        self.requests: list[TtsRequest] = []
        self.cancelled: list[str] = []

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        self.requests.append(request)
        if self._delay_s:
            await asyncio.sleep(self._delay_s)
        if self._error is not None:
            raise self._error
        return self._audio

    async def cancel(self, request_id: str) -> str:
        self.cancelled.append(request_id)
        return self._cancel_state


async def test_synthesize_returns_audio_and_strips_whitespace() -> None:
    adapter = FakeAdapter()
    audio = await TtsService(adapter).synthesize(_request(text=" 你好 "))

    assert audio.audio == b"RIFF"
    assert [request.text for request in adapter.requests] == ["你好"]


@pytest.mark.parametrize("text", ["   ", "\n", "\t"])
async def test_blank_text_is_rejected_before_touching_the_engine(text: str) -> None:
    """空串在契约层就被 pydantic 拦下（min_length=1）；全空白由用例层兜住。"""
    adapter = FakeAdapter()
    with pytest.raises(TtsError) as excinfo:
        await TtsService(adapter).synthesize(_request(text=text))

    assert excinfo.value.code == CODE_TTS_BAD_REQUEST
    assert adapter.requests == []


async def test_text_over_40_chars_is_rejected_before_touching_the_engine() -> None:
    """切句是 LLM 事件协议那一层的责任（§6.2）；这里只负责拦下来并说清楚。"""
    adapter = FakeAdapter()
    with pytest.raises(TtsError) as excinfo:
        await TtsService(adapter).synthesize(_request(text="啊" * 41))

    assert excinfo.value.code == CODE_TTS_BAD_REQUEST
    assert "41" in excinfo.value.message
    assert adapter.requests == []


async def test_exactly_40_chars_is_allowed() -> None:
    adapter = FakeAdapter()
    await TtsService(adapter).synthesize(_request(text="啊" * 40))

    assert len(adapter.requests) == 1


async def test_sentence_timeout_maps_to_dp_tts_002() -> None:
    adapter = FakeAdapter(delay_s=0.05)
    with pytest.raises(TtsError) as excinfo:
        await TtsService(adapter, timeout_s=0.01).synthesize(_request())

    assert excinfo.value.code == CODE_TTS_SENTENCE_TIMEOUT
    assert excinfo.value.user_hint


async def test_adapter_error_propagates_untouched() -> None:
    """D14：适配器抛出的错误（含引擎原话）不能被用例层改写。"""
    adapter = FakeAdapter(error=TtsError(CODE_TTS_ADAPTER_ERROR, "RuntimeError: boom"))
    with pytest.raises(TtsError) as excinfo:
        await TtsService(adapter).synthesize(_request())

    assert excinfo.value.code == CODE_TTS_ADAPTER_ERROR
    assert "boom" in excinfo.value.message


@pytest.mark.parametrize(
    ("state", "cancelled"),
    [(CANCEL_QUEUED, True), (CANCEL_IN_FLIGHT, True), (CANCEL_UNKNOWN, False)],
)
async def test_cancel_reports_effectiveness(state: str, cancelled: bool) -> None:
    """unknown 表示这句已经结束——是正常情况，不是错误（§6.12）。"""
    adapter = FakeAdapter(cancel_state=state)
    response = await TtsService(adapter).cancel("r9")

    assert response.cancelled is cancelled
    assert response.reason == state
    assert adapter.cancelled == ["r9"]


def test_build_tts_service_uses_settings() -> None:
    """组合根构造器走真实客户端：URL / token / 超时全部来自配置。"""
    settings = load_settings(
        env={"DESKPET_TTS_URL": "http://127.0.0.1:9999", "DESKPET_TTS_TIMEOUT_S": "12"}
    )
    service = build_tts_service(settings)

    assert isinstance(service, TtsService)
    assert service.adapter is not None
