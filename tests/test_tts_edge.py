"""文件职责：edge-tts 适配器的单测（T2.4）——音色选择、MP3 结果、错误路径。

为什么单测：edge-tts 是真的走网（微软服务），单测不能联网；用 monkeypatch 换掉延迟导入
（`_import_edge_tts`），就能在不装 edge-tts、不联网的情况下钉住协议形状与音色选择逻辑。
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from adapters import tts_edge
from adapters.tts_edge import EdgeTtsClient, EdgeTtsEndpoint
from contracts.api_models import TtsRequest
from core.errors import TtsError

ENDPOINT = EdgeTtsEndpoint(voice="zh-CN-XiaoxiaoNeural")


class _FakeCommunicate:
    """假的 edge_tts.Communicate：记录参数，stream 里吐一段音频。"""

    calls: list[tuple[str, str, dict[str, str]]] = []
    chunks: list[dict[str, object]] = [{"type": "audio", "data": b"\xff" * 600}]

    def __init__(self, text: str, voice: str, **options: str) -> None:
        _FakeCommunicate.calls.append((text, voice, options))

    async def stream(self) -> AsyncIterator[dict[str, object]]:
        for chunk in _FakeCommunicate.chunks:
            yield chunk


class _FakeEdgeTts:
    Communicate = _FakeCommunicate


def _request(voice_id: str) -> TtsRequest:
    return TtsRequest(text="你好", voice_id=voice_id, request_id="r1")


async def test_synthesize_returns_mp3_and_uses_default_voice_for_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeCommunicate.calls.clear()
    _FakeCommunicate.chunks = [{"type": "audio", "data": b"\xff" * 600}]
    monkeypatch.setattr(tts_edge, "_import_edge_tts", lambda: _FakeEdgeTts)
    client = EdgeTtsClient(ENDPOINT)

    audio = await client.synthesize(_request("D:/packs/amber/ref.wav"))

    assert audio.format == "mp3"
    assert audio.voice == "zh-CN-XiaoxiaoNeural"  # 参考音路径不是 edge 音色 → 用默认
    assert len(audio.audio) == 600
    assert audio.audio_ms == 100  # 600 字节 / 6 字节每毫秒
    assert _FakeCommunicate.calls[0][1] == "zh-CN-XiaoxiaoNeural"


async def test_synthesize_uses_edge_voice_when_voice_id_looks_like_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeCommunicate.calls.clear()
    _FakeCommunicate.chunks = [{"type": "audio", "data": b"\xff" * 6}]
    monkeypatch.setattr(tts_edge, "_import_edge_tts", lambda: _FakeEdgeTts)
    client = EdgeTtsClient(ENDPOINT)

    audio = await client.synthesize(_request("en-US-AriaNeural"))

    assert audio.voice == "en-US-AriaNeural"


async def test_no_audio_chunks_raises_tts_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeCommunicate.chunks = [{"type": "WordBoundary"}]
    monkeypatch.setattr(tts_edge, "_import_edge_tts", lambda: _FakeEdgeTts)
    client = EdgeTtsClient(ENDPOINT)

    with pytest.raises(TtsError) as info:
        await client.synthesize(_request("zh-CN-XiaoxiaoNeural"))
    assert info.value.code == "DP-TTS-500"


async def test_missing_library_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom() -> object:
        raise TtsError("DP-TTS-503", "edge-tts 未安装")

    monkeypatch.setattr(tts_edge, "_import_edge_tts", _boom)
    client = EdgeTtsClient(ENDPOINT)

    with pytest.raises(TtsError) as info:
        await client.synthesize(_request("zh-CN-XiaoxiaoNeural"))
    assert info.value.code == "DP-TTS-503"


async def test_cancel_is_always_unknown() -> None:
    client = EdgeTtsClient(ENDPOINT)
    assert await client.cancel("r1") == "unknown"
