"""文件职责：/ws/voice 全双工链路的端到端单测（P2）。

为什么用 TestClient 的 websocket_connect：它真的跑 FastAPI 的 WebSocket 路由与后台任务，
又不需要麦克风 / GPU / 网络；ASR / Chat / TTS 全部注入假实现，断言的是**协议与编排**。
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import create_app
from config import load_settings
from contracts.api_models import AsrResponse, ChatStreamRequest, TtsRequest
from contracts.events import EndEvent, SentenceEvent
from core.asr import Transcript
from core.tts import TtsAudio
from services.asr_service import AsrService

REPO_ROOT = Path(__file__).resolve().parents[1]


class FakeAsr:
    """假识别：默认回「你好」；text 为空时模拟「没听清」。"""

    def __init__(self, text: str = "你好") -> None:
        self.text = text
        self.calls = 0

    @property
    def is_loaded(self) -> bool:
        return True

    def load(self) -> None:
        """批处理适配器接口：假实现永远是已加载。"""

    def unload(self) -> None:
        """假实现没有资源要释放。"""

    async def transcribe(self, query: object, pcm: bytes) -> AsrResponse:
        self.calls += 1
        return AsrResponse(text=self.text, confidence=0.9, duration_s=0.5, language=None)


class FakeAsrStream:
    """假流式会话：每 accept 一次就多吐一个字，finish 给整句。"""

    def __init__(self, text: str) -> None:
        self._text = text
        self._partial = ""
        self._step = 0

    @property
    def partial(self) -> str:
        return self._partial

    def accept(self, pcm: bytes) -> str:
        self._step += 1
        self._partial = self._text[: min(len(self._text), self._step)]
        return self._partial

    def finish(self) -> Transcript:
        return Transcript(text=self._text, confidence=0.9, duration_s=1.0, language=None)

    def close(self) -> None:
        self._partial = ""


class FakeStreamingAsr:
    """假流式适配器：按 start_stream 开新会话。"""

    def __init__(self, text: str = "你好世界") -> None:
        self.text = text
        self.streams: list[FakeAsrStream] = []

    def start_stream(self, *, sample_rate: int, lang: str | None = None) -> FakeAsrStream:
        del sample_rate, lang
        stream = FakeAsrStream(self.text)
        self.streams.append(stream)
        return stream


class FakeChat:
    """假会话：一句台词 + end；记录收到的请求。"""

    def __init__(self, sentences: tuple[str, ...] = ("你好呀。",)) -> None:
        self.sentences = sentences
        self.requests: list[ChatStreamRequest] = []

    async def stream_events(self, request: ChatStreamRequest) -> AsyncIterator[object]:
        self.requests.append(request)
        for index, text in enumerate(self.sentences):
            yield SentenceEvent(text=text, i=index, emotion="喜", intensity=0.8, act="wave")
        yield EndEvent()


class FakeTts:
    """假合成：返回一小段假 wav；记录 TtsRequest。"""

    def __init__(self) -> None:
        self.requests: list[TtsRequest] = []

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        self.requests.append(request)
        return TtsAudio(
            audio=b"RIFFfake-audio",
            request_id=request.request_id,
            gen_ms=3,
            audio_ms=10,
            rtf=0.3,
            voice="fake",
            format="wav",
        )


def _settings():
    env = {
        "DESKPET_DATA_DIR": tempfile.mkdtemp(prefix="deskpet-ws-"),
        "DESKPET_CHARACTERS_DIR": str(REPO_ROOT / "characters"),
    }
    return load_settings(env=env)


def _app(
    *,
    token: str | None = None,
    asr: FakeAsr | None = None,
    chat: FakeChat | None = None,
    tts: FakeTts | None = None,
):
    return create_app(
        settings=_settings(),
        token=token,
        asr_service=asr or FakeAsr(),
        chat_service=chat or FakeChat(),
        tts_service=tts or FakeTts(),
    )


def _drain(ws: object) -> tuple[list[dict], list[bytes]]:
    """收消息直到 state=idle；返回所有 JSON 事件与二进制音频。"""
    events: list[dict] = []
    audio: list[bytes] = []
    while True:
        message = ws.receive()  # type: ignore[attr-defined]
        if message["type"] == "websocket.disconnect":
            break
        if message.get("bytes") is not None:
            audio.append(message["bytes"])
            continue
        text = message.get("text")
        if not text:
            continue
        event = json.loads(text)
        events.append(event)
        if event.get("t") == "state" and event.get("state") == "idle":
            break
    return events, audio


def test_voice_ws_audio_round_trip_streams_events_and_audio() -> None:
    """PCM → ASR → LLM → TTS 全链路：事件齐全、音频以二进制帧紧跟 tts.audio。"""
    chat = FakeChat()
    tts = FakeTts()
    with TestClient(_app(chat=chat, tts=tts)) as client:
        with client.websocket_connect("/ws/voice") as ws:
            ws.send_json(
                {"t": "audio.start", "session_id": "s1", "char_id": "amber", "sample_rate": 16000}
            )
            ws.send_bytes(b"\x00\x00" * 800)
            ws.send_json({"t": "audio.end", "session_id": "s1", "char_id": "amber"})
            events, audio = _drain(ws)

    kinds = [event["t"] for event in events]
    assert "asr.final" in kinds
    assert events[kinds.index("asr.final")]["text"] == "你好"
    sentence = events[kinds.index("llm.s")]
    assert sentence["text"] == "你好呀。"
    assert sentence["emotion"] == "喜"
    assert events[kinds.index("tts.audio")]["format"] == "wav"
    assert "llm.end" in kinds
    assert kinds[-1] == "state" and events[-1]["state"] == "idle"
    # 音频本体是独立的二进制帧（客户端按顺序与 tts.audio 配对）
    assert audio == [b"RIFFfake-audio"]
    # 这一轮是以 voice 身份进 ChatService 的（使用统计与记忆都按语音记）
    assert chat.requests[0].input_mode == "voice"
    assert chat.requests[0].text == "你好"
    # sidecar 自己从角色包拼 TtsRequest：参考音绝对路径 + zh + 喜的情绪向量（intensity 0.8）
    request = tts.requests[0]
    assert request.voice_id.replace("\\", "/").endswith("characters/amber/assets/reference.wav")
    assert request.lang == "zh"
    assert request.emo_weight == 0.8
    assert request.emo_vector[0] > 0.0  # 喜 的基向量第一维 > 0


def test_voice_ws_streams_partials_before_final() -> None:
    """流式识别：每个音频块都可能推 asr.partial，audio.end 后给 asr.final（P2）。"""
    stream_asr = FakeStreamingAsr("你好世界")
    service = AsrService(FakeAsr(), timeout_s=5.0, stream=stream_asr)
    with TestClient(_app(asr=service)) as client:
        with client.websocket_connect("/ws/voice") as ws:
            ws.send_json(
                {"t": "audio.start", "session_id": "s5", "char_id": "amber", "sample_rate": 16000}
            )
            ws.send_bytes(b"\x00\x00" * 1600)
            ws.send_bytes(b"\x00\x00" * 1600)
            ws.send_bytes(b"\x00\x00" * 1600)
            ws.send_json({"t": "audio.end", "session_id": "s5", "char_id": "amber"})
            events, _audio = _drain(ws)

    kinds = [event["t"] for event in events]
    assert kinds.count("asr.partial") >= 2
    assert "asr.final" in kinds
    assert events[kinds.index("asr.final")]["text"] == "你好世界"
    # partial 必须排在 final 之前
    assert kinds.index("asr.partial") < kinds.index("asr.final")


def test_voice_ws_tts_disabled_skips_synthesis() -> None:
    """语音输出关闭：台词照出（llm.s），但不合成、不下发音频（P2 开关）。"""
    tts = FakeTts()
    with TestClient(_app(tts=tts)) as client:
        with client.websocket_connect("/ws/voice") as ws:
            ws.send_json(
                {
                    "t": "audio.start",
                    "session_id": "s6",
                    "char_id": "amber",
                    "sample_rate": 16000,
                    "tts_enabled": False,
                }
            )
            ws.send_bytes(b"\x00\x00" * 800)
            ws.send_json({"t": "audio.end", "session_id": "s6", "char_id": "amber"})
            events, audio = _drain(ws)

    kinds = [event["t"] for event in events]
    assert "llm.s" in kinds
    assert "tts.audio" not in kinds
    assert audio == []
    assert tts.requests == []


def test_voice_ws_empty_asr_reports_and_goes_idle() -> None:
    """没听清：只发 asr.empty + idle，不调 LLM/TTS。"""
    chat = FakeChat()
    with TestClient(_app(asr=FakeAsr(text=""), chat=chat)) as client:
        with client.websocket_connect("/ws/voice") as ws:
            ws.send_json(
                {"t": "audio.start", "session_id": "s2", "char_id": "amber", "sample_rate": 16000}
            )
            ws.send_json({"t": "audio.end", "session_id": "s2", "char_id": "amber"})
            events, audio = _drain(ws)

    kinds = [event["t"] for event in events]
    assert kinds == ["asr.empty", "state"]
    assert events[-1]["state"] == "idle"
    assert audio == []
    assert chat.requests == []


def test_voice_ws_text_input_path() -> None:
    """同一条通道也接受文字：跳过 ASR，直接进 LLM。"""
    with TestClient(_app()) as client:
        with client.websocket_connect("/ws/voice") as ws:
            ws.send_json(
                {"t": "text", "session_id": "s3", "char_id": "amber", "text": "在吗"}
            )
            events, _audio = _drain(ws)

    kinds = [event["t"] for event in events]
    assert "asr.final" not in kinds
    assert events[kinds.index("llm.s")]["text"] == "你好呀。"


def test_voice_ws_rejects_missing_token() -> None:
    """带 token 启动时，没有 token 的连接必须被拒（回环 + token 是硬门槛）。"""
    with TestClient(_app(token="secret")) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/voice"):
                pass


def test_voice_ws_accepts_correct_token() -> None:
    with TestClient(_app(token="secret")) as client:
        with client.websocket_connect("/ws/voice?token=secret") as ws:
            ws.send_json(
                {"t": "text", "session_id": "s4", "char_id": "amber", "text": "在吗"}
            )
            events, _audio = _drain(ws)
    assert any(event["t"] == "llm.s" for event in events)
