"""文件职责：OpenAI 兼容云端识别适配器的单测（T2.4）——WAV 包装、成功、错误路径。

为什么单测：云端识别原来是「明确报未实现」，现在是一条真实的出网链路；用它自己的
PCM→WAV 封装 + httpx.MockTransport，能在无网络、无麦克风的情况下钉住协议形状与错误码。
"""

from __future__ import annotations

import httpx
import pytest

from adapters.asr_openai import OpenAiAsr, OpenAiAsrEndpoint, pcm16_to_wav
from core.errors import AsrError

ENDPOINT = OpenAiAsrEndpoint(
    base_url="https://api.groq.com/openai/v1",
    api_key="sk-test",
    model="whisper-large-v3-turbo",
    timeout_s=5.0,
)

SILENCE = b"\x00\x00" * 800  # 0.05s @16k 单声道


def _transport(handler: object) -> httpx.MockTransport:
    return httpx.MockTransport(handler)  # type: ignore[arg-type]


def test_pcm16_to_wav_writes_a_valid_riff_header() -> None:
    pcm = b"\x01\x02" * 10
    wav = pcm16_to_wav(pcm, 16000)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert wav[36:40] == b"data"
    assert len(wav) == 44 + len(pcm)
    # byte_rate = 16000 * 1 * 16 / 8 = 32000
    assert int.from_bytes(wav[28:32], "little") == 32000


async def test_transcribe_posts_multipart_and_parses_text() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = request.read()
        return httpx.Response(200, json={"text": "  你好，世界  "})

    asr = OpenAiAsr(ENDPOINT, transport=_transport(handler))
    result = await asr.transcribe(SILENCE, sample_rate=16000, lang="zh")

    assert seen["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer sk-test"
    body = seen["body"]
    assert isinstance(body, bytes)
    assert b"whisper-large-v3-turbo" in body
    assert b"RIFF" in body
    assert result.text == "你好，世界"
    assert result.confidence == 1.0
    assert result.language == "zh"


async def test_empty_transcript_reports_zero_confidence() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "   "})

    asr = OpenAiAsr(ENDPOINT, transport=_transport(handler))
    result = await asr.transcribe(SILENCE, sample_rate=16000)
    assert result.text == ""
    assert result.confidence == 0.0


async def test_http_error_becomes_asr_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid api key")

    asr = OpenAiAsr(ENDPOINT, transport=_transport(handler))
    with pytest.raises(AsrError) as info:
        await asr.transcribe(SILENCE, sample_rate=16000)
    assert info.value.code == "DP-ASR-004"


async def test_connect_error_becomes_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    asr = OpenAiAsr(ENDPOINT, transport=_transport(handler))
    with pytest.raises(AsrError) as info:
        await asr.transcribe(SILENCE, sample_rate=16000)
    assert info.value.code == "DP-ASR-004"


async def test_missing_endpoint_is_a_clear_error() -> None:
    asr = OpenAiAsr(
        OpenAiAsrEndpoint(base_url="", api_key="", model="m", timeout_s=5.0),
    )
    with pytest.raises(AsrError) as info:
        await asr.transcribe(SILENCE, sample_rate=16000)
    assert info.value.code == "DP-ASR-004"
