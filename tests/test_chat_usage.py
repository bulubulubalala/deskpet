"""文件职责：单测「使用统计接进会话主流程」——只记事实、不落盘、失败不影响回复（§6.9）。

依赖方向：tests -> services / config / contracts + 仓库 characters/ 的示例角色包；不联网。
谁调用：pytest。

这里只关心接线：什么时候记一轮、voice 与 text 怎么分、角色包坏掉时不该记、每轮结束有没有
给统计层一次落盘机会。真正的累计与写盘语义在 tests/test_usage_service.py。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import cast

from adapters.llm_openai import OpenAiChatClient
from config import LlmSettings
from contracts.api_models import ChatStreamRequest
from contracts.events import EndEvent, ErrorEvent, LlmEvent, SentenceEvent
from services.chat_service import ChatService

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARACTERS_DIR = REPO_ROOT / "characters"
SENTENCE_LINE = '{"t":"s","i":0,"text":"你好呀。","emotion":"平静","intensity":0.3}'
END_LINE = '{"t":"end"}'


class FakeClient:
    """回放两行的假客户端：一句台词 + 收尾。"""

    async def stream_chat(self, messages: Sequence[Mapping[str, str]]) -> AsyncIterator[str]:
        for line in (SENTENCE_LINE, END_LINE):
            yield line + "\n"


class FakeRecorder:
    """实现 core.usage.UsageRecorder 的假统计件（只记调用，不落盘）。"""

    def __init__(self) -> None:
        self.turns: list[tuple[str, str, bool]] = []
        self.interrupts: list[str] = []
        self.flush_calls = 0

    def record_turn(
        self, session_id: str, char_id: str, *, voice: bool, at: float | None = None
    ) -> None:
        self.turns.append((session_id, char_id, voice))

    def record_interrupt(self, session_id: str, *, at: float | None = None) -> None:
        self.interrupts.append(session_id)

    async def flush_if_due(self) -> bool:
        self.flush_calls += 1
        return False


def _service(usage: FakeRecorder | None) -> ChatService:
    def factory(_endpoint: object) -> OpenAiChatClient:
        return cast(OpenAiChatClient, FakeClient())

    return ChatService(
        llm=LlmSettings(base_url="https://api.example.com/v1", api_key="k", model="m"),
        characters_dir=CHARACTERS_DIR,
        client_factory=factory,
        usage=usage,
    )


async def _drain(service: ChatService, request: ChatStreamRequest) -> list[LlmEvent]:
    return [event async for event in service.stream_events(request)]


def _request(char_id: str = "amber", input_mode: str = "text") -> ChatStreamRequest:
    return ChatStreamRequest(
        session_id="s1", char_id=char_id, text="你好", input_mode=input_mode  # type: ignore[arg-type]
    )


async def test_text_turn_is_recorded_and_flushed() -> None:
    recorder = FakeRecorder()

    events = await _drain(_service(recorder), _request())

    assert any(isinstance(event, SentenceEvent) for event in events)
    assert recorder.turns == [("s1", "amber", False)]
    assert recorder.flush_calls == 1


async def test_voice_turn_is_marked_as_voice() -> None:
    recorder = FakeRecorder()

    await _drain(_service(recorder), _request(input_mode="voice"))

    assert recorder.turns == [("s1", "amber", True)]


async def test_broken_pack_is_not_recorded() -> None:
    """角色包都加载不起来，这一轮不算「用户用过这个角色」。"""
    recorder = FakeRecorder()

    events = await _drain(_service(recorder), _request(char_id="does-not-exist"))

    assert any(isinstance(event, ErrorEvent) for event in events)
    assert recorder.turns == []
    assert recorder.flush_calls == 0


async def test_interrupt_is_forwarded_to_recorder() -> None:
    recorder = FakeRecorder()

    _service(recorder).record_interrupt("s1")

    assert recorder.interrupts == ["s1"]


async def test_without_usage_service_the_stream_still_works() -> None:
    """统计是可选的：没有它时主流程一个字都不提它。"""
    events = await _drain(_service(None), _request())

    assert any(isinstance(event, EndEvent) for event in events)
