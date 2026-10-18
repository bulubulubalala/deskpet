"""文件职责：单测 services/chat_service.py 的事件流语义（重试 / 降级 / 收尾，需求 §6.2 §6.7）。

依赖方向：tests -> services / config / contracts + 仓库 characters/ 里的示例包；不联网。
谁调用：pytest。

这里检验的是「用户会看到什么」：什么时候重试、什么时候如实报错、什么时候把坏输出
降级成台词。全部用假客户端注入，不碰真实模型——真实端点的行为由 T1.13 的实测覆盖。
"""

import asyncio
import json
import random
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import cast

import pytest

from adapters.llm_openai import OpenAiChatClient
from config import LlmSettings
from contracts.api_models import ChatInteraction, ChatStreamRequest
from contracts.errors import CODE_LLM_BAD_RESPONSE, CODE_LLM_TIMEOUT, CODE_PACK_FIELD_MISSING
from contracts.events import EndEvent, ErrorEvent, SentenceEvent
from core.errors import LlmError
from core.prompt import UNTRUSTED_OPEN
from services.chat_service import ChatService

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARACTERS_DIR = REPO_ROOT / "characters"
SENTENCE_LINE = '{"t":"s","i":0,"text":"你好呀。","emotion":"平静","intensity":0.3}'
END_LINE = '{"t":"end"}'


class FakeClient:
    """按脚本回放的假客户端：先逐行 yield，再按需抛错；delay_s 用来复现慢端点。"""

    def __init__(
        self,
        lines: Sequence[str] = (),
        *,
        error: Exception | None = None,
        delay_s: float = 0.0,
    ) -> None:
        self.lines = list(lines)
        self.error = error
        self.delay_s = delay_s
        self.calls = 0
        self.messages: list[dict[str, str]] = []

    async def stream_chat(self, messages: Sequence[Mapping[str, str]]) -> AsyncIterator[str]:
        self.calls += 1
        self.messages = [dict(message) for message in messages]
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        # 模型是逐行吐 JSON 的：每行必须带换行，服务层才会按行解析（少了它两行会被拼成一行）
        for line in self.lines:
            yield line + "\n"
        if self.error is not None:
            raise self.error


def _request(text: str = "你好", char_id: str = "amber") -> ChatStreamRequest:
    return ChatStreamRequest(session_id="s1", char_id=char_id, text=text)


def _llm(**overrides: object) -> LlmSettings:
    base: dict[str, object] = {
        "base_url": "https://api.example.com/v1",
        "api_key": "k",
        "model": "m",
    }
    base.update(overrides)
    return LlmSettings(**base)  # type: ignore[arg-type]


def _service(
    client: FakeClient | None = None,
    *,
    llm: LlmSettings | None = None,
    sleeps: list[float] | None = None,
    factory: object | None = None,
) -> tuple[ChatService, list[float]]:
    recorded = sleeps if sleeps is not None else []

    async def sleep(delay: float) -> None:
        recorded.append(delay)

    def default_factory(_endpoint: object) -> OpenAiChatClient:
        assert client is not None
        return cast(OpenAiChatClient, client)

    return (
        ChatService(
            llm=llm or _llm(),
            characters_dir=CHARACTERS_DIR,
            client_factory=cast(object, factory or default_factory),  # type: ignore[arg-type]
            sleep=sleep,
        ),
        recorded,
    )


async def _events(service: ChatService, request: ChatStreamRequest | None = None) -> list[object]:
    return [event async for event in service.stream_events(request or _request())]


async def test_missing_endpoint_reports_configuration_problem() -> None:
    """没配 DESKPET_LLM_*：明确说「还没配置模型服务」，且不可重试（重试没意义）。"""
    service, _ = _service(FakeClient(), llm=LlmSettings())
    events = await _events(service)
    assert isinstance(events[0], ErrorEvent)
    assert events[0].code == CODE_LLM_BAD_RESPONSE
    assert events[0].recoverable is False
    assert isinstance(events[-1], EndEvent)


async def test_missing_pack_does_not_crash_the_stream() -> None:
    """角色包缺失 / 损坏：拒绝加载并说清是哪一类问题，绝不让整个 sidecar 崩掉。"""
    service, _ = _service(FakeClient())
    events = await _events(service, _request(char_id="__not_a_character__"))
    assert isinstance(events[0], ErrorEvent)
    assert events[0].code == CODE_PACK_FIELD_MISSING
    assert isinstance(events[-1], EndEvent)


async def test_valid_event_lines_pass_through_with_prompt_prefix() -> None:
    """正常一轮：事件原样透传，且系统提示词里带上了角色设定。"""
    client = FakeClient([SENTENCE_LINE, END_LINE])
    service, _ = _service(client)
    events = await _events(service)
    assert [type(event) for event in events] == [SentenceEvent, EndEvent]
    sentence = cast(SentenceEvent, events[0])
    assert sentence.text == "你好呀。"
    assert client.messages[0]["role"] == "system"
    assert "琥珀" in client.messages[0]["content"]
    assert client.messages[-1] == {"role": "user", "content": "你好"}


async def test_system_prompt_carries_current_state() -> None:
    """每轮都带上「此刻状态」（F8 验收 2）：注入的 now/rng 让这段话可复现。"""
    client = FakeClient([SENTENCE_LINE, END_LINE])
    service = ChatService(
        llm=_llm(),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, lambda _endpoint: client),  # type: ignore[arg-type]
        now=lambda: datetime(2026, 1, 1, 3, 0, 0).timestamp(),
        rng=random.Random(7),
    )
    await _events(service)
    system = client.messages[0]["content"]
    assert "【此刻的状态】" in system
    assert "现在是凌晨；" in system


async def test_plain_text_output_is_split_into_sentences() -> None:
    """模型不按协议输出时降级成纯文本台词，而不是报错或沉默。"""
    client = FakeClient(["你好，今天天气不错"])
    service, _ = _service(client)
    events = await _events(service)
    assert isinstance(events[-1], EndEvent)
    pieces = [cast(SentenceEvent, event) for event in events[:-1]]
    assert all(isinstance(event, SentenceEvent) for event in events[:-1])
    assert "".join(piece.text for piece in pieces) == "你好，今天天气不错"


async def test_over_long_sentence_is_cut_to_engine_limit() -> None:
    """超过 40 字的合法事件也要被切开：这是引擎吞字的最后一道保险。"""
    text = "字" * 100
    line = json.dumps({"t": "s", "i": 0, "text": text, "emotion": "平静", "intensity": 0.5})
    service, _ = _service(FakeClient([line, END_LINE]))
    events = await _events(service)
    pieces = [cast(SentenceEvent, event) for event in events if isinstance(event, SentenceEvent)]
    assert len(pieces) >= 3
    assert all(len(piece.text) <= 40 for piece in pieces)
    assert "".join(piece.text for piece in pieces) == text


async def test_invalid_event_line_speaks_text_field_not_raw_json() -> None:
    """整行是 JSON 但字段不合规时，念 text 字段而不是花括号原文。"""
    line = json.dumps({"t": "s", "i": 0, "text": "我很好。", "emotion": "平静", "intensity": "高"})
    service, _ = _service(FakeClient([line, END_LINE]))
    events = await _events(service)
    pieces = [cast(SentenceEvent, event) for event in events if isinstance(event, SentenceEvent)]
    assert [piece.text for piece in pieces] == ["我很好。"]


async def test_multi_line_json_event_is_joined_before_parsing() -> None:
    """模型把事件写成缩进的多行时先拼回再解析，不能把花括号逐行当台词念（§6.2）。"""
    client = FakeClient(
        [
            '{"t":"s","i":0,',
            ' "text":"我在。","emotion":"平静","intensity":0.5}',
            END_LINE,
        ]
    )
    service, _ = _service(client)
    events = await _events(service)
    pieces = [cast(SentenceEvent, event) for event in events if isinstance(event, SentenceEvent)]
    assert [piece.text for piece in pieces] == ["我在。"]


async def test_unparsable_json_line_speaks_only_the_text_field() -> None:
    """真机案例：模型在闭合花括号前多写一个引号，只念 text，不念花括号尾巴。"""
    line = '{"t":"s","i":0,"text":"团子啊。","emotion":"平静","intensity":0.5"}'
    service, _ = _service(FakeClient([line, END_LINE]))
    events = await _events(service)
    pieces = [cast(SentenceEvent, event) for event in events if isinstance(event, SentenceEvent)]
    assert [piece.text for piece in pieces] == ["团子啊。"]


async def test_json_line_without_text_field_is_not_spoken() -> None:
    """连 text 字段都没有的坏报文：宁可少一句，也不把花括号念给用户。"""
    bad = '{"t":"s","i":0,"emotion":"平静"}'
    service, _ = _service(FakeClient([bad, END_LINE]))
    events = await _events(service)
    assert [type(event) for event in events] == [EndEvent]


async def test_stream_without_end_event_gets_one_appended() -> None:
    """模型忘了发 end：服务层补一个，前端才能确定本轮结束。"""
    service, _ = _service(
        FakeClient(['{"t":"s","i":0,"text":"好。","emotion":"平静","intensity":0.2}'])
    )
    events = await _events(service)
    assert isinstance(events[-1], EndEvent)


async def test_empty_stream_is_reported_as_bad_response() -> None:
    """流正常结束却一个事件都没有（多半端点不认 stream=true）：如实报错，别假装成功。"""
    service, _ = _service(FakeClient([]), llm=_llm(retry_delays_s=()))
    events = await _events(service)
    assert isinstance(events[0], ErrorEvent)
    assert events[0].code == CODE_LLM_BAD_RESPONSE


async def test_first_attempt_failure_retries_with_backoff() -> None:
    """尚未产出任何事件可以重试：按 §6.7 退避 1s，然后成功。"""
    failing = FakeClient(error=LlmError(CODE_LLM_TIMEOUT, "boom", user_hint="x"))
    ok = FakeClient([SENTENCE_LINE, END_LINE])
    clients = [failing, ok]

    def factory(_endpoint: object) -> OpenAiChatClient:
        return cast(OpenAiChatClient, clients.pop(0))

    service, sleeps = _service(factory=factory)
    events = await _events(service)
    assert isinstance(events[0], SentenceEvent)
    assert handed_kinds(events)[-1] == "end"
    assert sleeps == [1.0]
    assert failing.calls == 1
    assert ok.calls == 1


def handed_kinds(events: Sequence[object]) -> list[str]:
    return [getattr(event, "t") for event in events]


async def test_failure_after_output_never_replays() -> None:
    """已经播出去的句子不能收回：直接如实收尾，绝不重播上一句（§6.7）。"""
    client = FakeClient(
        ['{"t":"s","i":0,"text":"第一句。","emotion":"平静","intensity":0.2}'],
        error=LlmError(CODE_LLM_TIMEOUT, "boom", user_hint="网络不通"),
    )
    service, sleeps = _service(client, llm=_llm(retry_delays_s=(1.0, 3.0)))
    events = await _events(service)
    assert handed_kinds(events) == ["s", "e", "end"]
    error = cast(ErrorEvent, events[1])
    assert error.recoverable is True
    assert client.calls == 1
    assert sleeps == []


async def test_all_attempts_exhausted_uses_last_error_code() -> None:
    """所有重试用尽：用最后一次的错误码提示，绝不无限转圈。"""
    client = FakeClient(error=LlmError(CODE_LLM_TIMEOUT, "boom", user_hint="网络不通"))
    service, sleeps = _service(client)
    events = await _events(service)
    assert handed_kinds(events) == ["e", "end"]
    assert cast(ErrorEvent, events[0]).code == CODE_LLM_TIMEOUT
    assert client.calls == 3
    assert sleeps == [1.0, 3.0]


async def test_fallback_endpoint_is_tried_without_retry_delay() -> None:
    """主端点失败、配了备用端点时先换端点（§6.7 第二层降级），不该在同一后端死磕。"""
    seen: list[str] = []
    failing = FakeClient(error=LlmError(CODE_LLM_TIMEOUT, "boom", user_hint="x"))
    ok = FakeClient([SENTENCE_LINE, END_LINE])
    clients = [failing, ok]

    def factory(endpoint: object) -> OpenAiChatClient:
        seen.append(str(getattr(endpoint, "base_url")))
        return cast(OpenAiChatClient, clients.pop(0))

    service, _ = _service(
        factory=factory,
        llm=_llm(
            fallback_base_url="https://backup.example.com/v1",
            fallback_model="m2",
            retry_delays_s=(),
        ),
    )
    events = await _events(service)
    assert isinstance(events[0], SentenceEvent)
    assert seen == ["https://api.example.com/v1", "https://backup.example.com/v1"]


async def test_first_token_timeout_maps_to_timeout_error() -> None:
    """慢端点：首 token 超时按 DP-LLM-003 报错并收尾（对齐 §6.7 的 20s 预算）。"""
    slow = FakeClient([END_LINE], delay_s=5.0)
    service, _ = _service(
        slow,
        llm=_llm(first_token_timeout_s=0.01, total_timeout_s=0.05, retry_delays_s=()),
    )
    events = await _events(service)
    assert handed_kinds(events) == ["e", "end"]
    assert cast(ErrorEvent, events[0]).code == CODE_LLM_TIMEOUT


class FakeUsage:
    """只记「谁记过什么」的假记账器（真落盘行为由 test_usage_service.py 覆盖）。"""

    def __init__(self) -> None:
        self.turns: list[tuple[str, str, bool]] = []
        self.providers: list[tuple[str, str]] = []

    def record_turn(
        self,
        session_id: str,
        char_id: str,
        *,
        voice: bool,
        at: float | None = None,
    ) -> None:
        self.turns.append((session_id, char_id, voice))

    def record_interrupt(self, session_id: str, *, at: float | None = None) -> None:
        return None

    def record_provider(self, session_id: str, name: str) -> None:
        self.providers.append((session_id, name))

    async def flush_if_due(self) -> bool:
        return False


def test_endpoints_follow_provider_order() -> None:
    """T1.14：候选端点顺序 = 选中 provider → 另一个已配 provider。"""
    llm = _llm(
        provider="local",
        local_base_url="http://127.0.0.1:11434/v1",
        local_model="local-model",
    )
    service, _ = _service(llm=llm)
    assert [(endpoint.base_url, label) for endpoint, label in service.endpoints()] == [
        ("http://127.0.0.1:11434/v1", "local"),
        ("https://api.example.com/v1", "cloud"),
    ]


async def test_fallback_records_the_provider_that_actually_answered() -> None:
    """主用端点挂了切备用：这一轮记的是备用，而不是配置里的主用。"""
    usage = FakeUsage()
    primary = FakeClient(error=LlmError(CODE_LLM_BAD_RESPONSE, "端点挂了"))

    def factory(endpoint: object) -> FakeClient:
        base_url = getattr(endpoint, "base_url", "")
        if base_url == "https://api.example.com/v1":
            return primary
        return FakeClient([SENTENCE_LINE, END_LINE])

    async def sleep(delay: float) -> None:
        del delay  # 退避等待在测试里直接跳过

    service = ChatService(
        llm=_llm(fallback_base_url="https://backup.example.com/v1", fallback_model="m2"),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, factory),  # type: ignore[arg-type]
        sleep=sleep,
        usage=cast(object, usage),  # type: ignore[arg-type]
    )
    events = await _events(service)

    assert isinstance(events[-1], EndEvent)
    assert usage.providers == [("s1", "fallback")]


class FakeSummarizer:
    """假压缩调度器：只记下「谁被排了压缩」（T2.1b）。"""

    def __init__(self) -> None:
        self.scheduled: list[str] = []

    def schedule(self, char_id: str) -> None:
        self.scheduled.append(char_id)


async def test_turn_end_schedules_compression() -> None:
    """每轮收尾都排一次阶梯压缩，但它只排队、不阻塞事件流（T2.1b）。"""
    client = FakeClient([SENTENCE_LINE, END_LINE])
    summarizer = FakeSummarizer()
    service = ChatService(
        llm=_llm(),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, lambda _endpoint: client),  # type: ignore[arg-type]
        summarizer=cast(object, summarizer),  # type: ignore[arg-type]
    )
    events = await _events(service)
    assert [type(event) for event in events] == [SentenceEvent, EndEvent]
    assert summarizer.scheduled == ["amber"]


async def test_compression_schedule_failure_does_not_break_the_turn() -> None:
    """压缩调度自己炸了也不能影响这一轮（§6.4：记忆是增强项）。"""

    class Boom:
        def schedule(self, char_id: str) -> None:
            raise RuntimeError("boom")

    client = FakeClient([SENTENCE_LINE, END_LINE])
    service = ChatService(
        llm=_llm(),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, lambda _endpoint: client),  # type: ignore[arg-type]
        summarizer=cast(object, Boom()),  # type: ignore[arg-type]
    )
    events = await _events(service)
    assert [type(event) for event in events] == [SentenceEvent, EndEvent]


class FakeUsageRecorder:
    """只关心 record_turn 有没有被调用的假统计件（T2.3-C2b）。"""

    def __init__(self) -> None:
        self.turns: list[tuple[str, str, bool]] = []
        self.providers: list[tuple[str, str]] = []

    def record_turn(
        self, session_id: str, char_id: str, *, voice: bool, at: float | None = None
    ) -> None:
        self.turns.append((session_id, char_id, voice))

    def record_interrupt(self, session_id: str, *, at: float | None = None) -> None:
        """本用例不涉及打断。"""

    def record_provider(self, session_id: str, name: str) -> None:
        self.providers.append((session_id, name))

    async def flush_if_due(self) -> bool:
        return False


def _interaction_request() -> ChatStreamRequest:
    return ChatStreamRequest(
        session_id="s1",
        char_id="amber",
        text="",
        interaction=ChatInteraction(region_id="head", region_name="头", streak=4, kind="single"),
    )


async def test_interaction_turn_becomes_the_user_message() -> None:
    """互动轮（部位点击）没有台词：sidecar 把互动写成人话当本轮用户消息（T2.3-C2b）。"""
    client = FakeClient([SENTENCE_LINE, END_LINE])
    service, _ = _service(client)
    events = await _events(service, _interaction_request())

    assert [type(event) for event in events] == [SentenceEvent, EndEvent]
    content = client.messages[-1]["content"]
    assert content.startswith("以下是刚刚发生的动作")
    assert "你的「头」 4 下" in content
    assert UNTRUSTED_OPEN in content


async def test_interaction_turn_is_not_counted_as_a_user_message() -> None:
    """互动轮不算一条「用户消息」（T2.3-C2b）：它只进 usage.db 的 char_hits。"""
    client = FakeClient([SENTENCE_LINE, END_LINE])
    usage = FakeUsageRecorder()
    service = ChatService(
        llm=_llm(),
        characters_dir=CHARACTERS_DIR,
        client_factory=cast(object, lambda _endpoint: client),  # type: ignore[arg-type]
        usage=cast(object, usage),  # type: ignore[arg-type]
    )

    await _events(service, _interaction_request())
    assert usage.turns == []

    await _events(service, _request(text="你好"))
    assert usage.turns == [("s1", "amber", False)]
