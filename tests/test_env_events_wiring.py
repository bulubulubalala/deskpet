"""文件职责：单测 T1.10 的接线——ASR / TTS / 会话三个模块真的往事件总线上报（§6.8）。

依赖方向：tests -> services / core / config / contracts；不联网、不碰硬件。
谁调用：pytest。

这一层不测总线本身（见 test_env_events.py），只回答一个问题：
「模块出事时，总线上到底有没有那条事实？」
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import cast

import pytest
from adapters.llm_openai import USER_HINT_NETWORK, USER_HINT_TIMEOUT, OpenAiChatClient
from contracts.api_models import AsrQuery, ChatStreamRequest, TtsRequest
from contracts.errors import CODE_LLM_TIMEOUT, CODE_TTS_NOT_AVAILABLE
from core.asr import Transcript
from core.env_events import (
    EVENT_ASR_EMPTY,
    EVENT_NET_DOWN,
    EVENT_TTS_FAILED,
    LEVEL_A,
    LEVEL_B,
    EnvEventBus,
)
from core.errors import LlmError, TtsError
from core.tts import TtsAudio
from services.asr_service import AsrService
from services.chat_service import ChatService
from services.tts_service import TtsService

from config import LlmSettings, Settings

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARACTERS_DIR = REPO_ROOT / "characters"
SENTENCE_LINE = '{"t":"s","i":0,"text":"你好呀。","emotion":"平静","intensity":0.3}'
END_LINE = '{"t":"end"}'


# ------------------------------------------------------------------ ASR


class FakeAsr:
    """按脚本依次返回识别结果的假适配器（is_loaded 恒真，跳过加载）。"""

    def __init__(self, results: Sequence[Transcript]) -> None:
        self._results = list(results)
        self.calls = 0

    @property
    def is_loaded(self) -> bool:
        return True

    def load(self) -> None:
        return None

    def unload(self) -> None:
        return None

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        self.calls += 1
        return self._results[min(self.calls - 1, len(self._results) - 1)]


async def test_asr_empty_reports_event() -> None:
    bus = EnvEventBus(instance="test")
    service = AsrService(
        cast(object, FakeAsr([Transcript(text="", confidence=0.0, duration_s=0.5)])),  # type: ignore[arg-type]
        timeout_s=1.0,
        env=bus,
    )

    response = await service.transcribe(AsrQuery(request_id="r1"), b"\x00\x00" * 100)

    assert response.text == ""
    active = bus.active()
    assert [event.id for event in active] == [EVENT_ASR_EMPTY]
    assert active[0].level == LEVEL_A
    assert active[0].user_hint  # 提示给 UI，fact 才是给提示词的


async def test_asr_hallucination_counts_as_empty() -> None:
    bus = EnvEventBus(instance="test")
    service = AsrService(
        cast(
            object,
            FakeAsr([Transcript(text="谢谢观看", confidence=0.9, duration_s=3.0)]),
        ),  # type: ignore[arg-type]
        timeout_s=1.0,
        env=bus,
    )

    await service.transcribe(AsrQuery(request_id="r2"), b"\x01\x02" * 800)

    assert [event.id for event in bus.active()] == [EVENT_ASR_EMPTY]
    assert "not_meaningful" in bus.active()[0].fact


async def test_asr_success_clears_empty_event() -> None:
    bus = EnvEventBus(instance="test")
    results = [
        Transcript(text="", confidence=0.0, duration_s=0.5),
        Transcript(text="今天天气不错", confidence=0.8, duration_s=2.0, language="zh"),
    ]
    service = AsrService(cast(object, FakeAsr(results)), timeout_s=1.0, env=bus)  # type: ignore[arg-type]

    await service.transcribe(AsrQuery(request_id="r3"), b"\x00\x00" * 100)
    assert [event.id for event in bus.active()] == [EVENT_ASR_EMPTY]
    response = await service.transcribe(AsrQuery(request_id="r4"), b"\x00\x00" * 100)

    assert response.text == "今天天气不错"
    assert bus.active() == ()  # 识别成功即视为恢复，不必等 ttl


# ------------------------------------------------------------------ TTS


class FakeTts:
    """假 TTS 适配器：失败时抛引擎侧异常，成功时回一段占位音频。"""

    def __init__(self, error: TtsError | None = None) -> None:
        self.error = error

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        if self.error is not None:
            raise self.error
        return TtsAudio(
            audio=b"RIFF",
            request_id=request.request_id,
            gen_ms=10,
            audio_ms=20,
            rtf=0.5,
            voice=request.voice_id,
        )

    async def cancel(self, request_id: str) -> str:
        return "unknown"


def _tts_request() -> TtsRequest:
    return TtsRequest(
        text="你好",
        voice_id="amber",
        lang="zh",
        emo_vector=[0.0] * 8,
        request_id="t1",
    )


async def test_tts_failure_reports_event_and_keeps_error() -> None:
    bus = EnvEventBus(instance="test")
    failure = TtsError(
        CODE_TTS_NOT_AVAILABLE,
        "引擎没在跑",
        user_hint="先启动 IndexTTS 适配器",
    )
    service = TtsService(cast(object, FakeTts(failure)), timeout_s=1.0, env=bus)  # type: ignore[arg-type]

    with pytest.raises(TtsError) as caught:
        await service.synthesize(_tts_request())

    assert caught.value.code == CODE_TTS_NOT_AVAILABLE  # D14：错误照旧抛给调用方
    active = bus.active()
    assert [event.id for event in active] == [EVENT_TTS_FAILED]
    assert active[0].level == LEVEL_B
    assert CODE_TTS_NOT_AVAILABLE in active[0].fact
    assert active[0].user_hint == "先启动 IndexTTS 适配器"


async def test_tts_success_clears_failure_event() -> None:
    bus = EnvEventBus(instance="test")
    broken = TtsService(
        cast(object, FakeTts(TtsError(CODE_TTS_NOT_AVAILABLE, "引擎没在跑"))),  # type: ignore[arg-type]
        timeout_s=1.0,
        env=bus,
    )
    healed = TtsService(cast(object, FakeTts()), timeout_s=1.0, env=bus)  # type: ignore[arg-type]

    with pytest.raises(TtsError):
        await broken.synthesize(_tts_request())
    assert [event.id for event in bus.active()] == [EVENT_TTS_FAILED]

    await healed.synthesize(_tts_request())
    assert bus.active() == ()


async def test_tts_too_long_text_is_not_an_engine_failure() -> None:
    """参数错是调用方的问题（DP-TTS-400），不该让角色以为引擎坏了。"""
    bus = EnvEventBus(instance="test")
    service = TtsService(cast(object, FakeTts()), timeout_s=1.0, env=bus)  # type: ignore[arg-type]

    with pytest.raises(TtsError):
        await service.synthesize(_tts_request().model_copy(update={"text": "字" * 41}))

    assert bus.active() == ()


# ------------------------------------------------------------------ 会话（LLM 网络）


class FakeClient:
    """按脚本回放的假 LLM 客户端：先逐行 yield，再按需抛错。"""

    def __init__(
        self, lines: Sequence[str] = (), error: Exception | None = None
    ) -> None:
        self.lines = list(lines)
        self.error = error
        self.messages: Sequence[Mapping[str, str]] = ()

    async def stream_chat(
        self, messages: Sequence[Mapping[str, str]]
    ) -> AsyncIterator[str]:
        self.messages = messages
        for line in self.lines:
            yield line + "\n"
        if self.error is not None:
            raise self.error


def _llm(**overrides: object) -> LlmSettings:
    base: dict[str, object] = {
        "base_url": "https://api.example.com/v1",
        "api_key": "k",
        "model": "m",
        "retry_delays_s": (),
    }
    base.update(overrides)
    return LlmSettings(**base)  # type: ignore[arg-type]


def _chat_service(
    client: FakeClient, bus: EnvEventBus, **llm_overrides: object
) -> ChatService:
    def factory(_endpoint: object) -> OpenAiChatClient:
        return cast(OpenAiChatClient, client)

    return ChatService(
        llm=_llm(**llm_overrides),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, factory),  # type: ignore[arg-type]
        env=bus,
    )


def _chat_request() -> ChatStreamRequest:
    return ChatStreamRequest(session_id="s1", char_id="amber", text="你好")


async def test_chat_network_error_reports_net_down() -> None:
    bus = EnvEventBus(instance="test")
    error = LlmError(CODE_LLM_TIMEOUT, "connect error", user_hint=USER_HINT_NETWORK)
    service = _chat_service(FakeClient(error=error), bus)

    events = [event async for event in service.stream_events(_chat_request())]

    assert events[-1].t == "end"
    active = bus.active()
    assert [event.id for event in active] == [EVENT_NET_DOWN]
    assert active[0].level == LEVEL_B
    assert active[0].user_hint == USER_HINT_NETWORK


async def test_chat_timeout_is_not_reported_as_net_down() -> None:
    """首 token 超时同样是 DP-LLM-003，但它不是断网（不该触发「联系不上」的台词）。"""
    bus = EnvEventBus(instance="test")
    error = LlmError(CODE_LLM_TIMEOUT, "首 token 超时", user_hint=USER_HINT_TIMEOUT)
    service = _chat_service(FakeClient(error=error), bus)

    _ = [event async for event in service.stream_events(_chat_request())]

    assert bus.active() == ()


async def test_chat_injects_active_env_fact_but_not_user_hint() -> None:
    bus = EnvEventBus(instance="test")
    bus.report(
        EVENT_NET_DOWN,
        fact="连不上模型服务（网络不通）",
        user_hint="请检查代理和网络",
    )
    client = FakeClient(lines=[SENTENCE_LINE, END_LINE])
    service = _chat_service(client, bus)

    _ = [event async for event in service.stream_events(_chat_request())]

    system = str(client.messages[0]["content"])
    assert "你现在连不上网络。" in system
    assert "net.down" not in system
    assert "请检查代理和网络" not in system


async def test_chat_success_clears_net_down() -> None:
    bus = EnvEventBus(instance="test")
    bus.report(EVENT_NET_DOWN, fact="连不上模型服务（网络不通）")
    service = _chat_service(FakeClient(lines=[SENTENCE_LINE, END_LINE]), bus)

    events = [event async for event in service.stream_events(_chat_request())]

    assert [event.t for event in events] == ["s", "end"]
    assert bus.active() == ()


# ------------------------------------------------------------------ 组合根


def test_create_app_exposes_env_events(tmp_path: Path) -> None:
    from app import create_app

    bus = EnvEventBus(instance="test")
    app = create_app(settings=Settings(data_dir=tmp_path), env_events=bus)

    assert app.state.env_events is bus
