"""文件职责：/chat/stream 的 HTTP 层契约测试（SSE 帧格式、200 下的错误事件）。

依赖方向：tests -> app（组合根）+ FastAPI TestClient + 假 LLM 客户端；不联网。
谁调用：pytest。

关键点：响应头一旦发出就是 200，后续任何失败都必须变成 §6.2 的 error 事件——
所以这里断言的是「HTTP 200 + 事件里说明失败」，而不是 HTTP 5xx。
"""

import json
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from adapters.llm_openai import OpenAiChatClient
from app import create_app
from config import LlmSettings
from contracts.events import LLM_EVENT_KINDS
from services.chat_service import ChatService

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARACTERS_DIR = REPO_ROOT / "characters"
SSE_MEDIA_TYPE = "text/event-stream"
SENTENCE_LINE = '{"t":"s","i":0,"text":"你好。","emotion":"平静","intensity":0.4}'
END_LINE = '{"t":"end"}'


class FakeClient:
    """最小假客户端：逐行回放，可选在回放后抛错。"""

    def __init__(self, lines: Sequence[str] = (), *, error: Exception | None = None) -> None:
        self.lines = list(lines)
        self.error = error

    async def stream_chat(self, messages: Sequence[Mapping[str, str]]) -> AsyncIterator[str]:
        # 逐行吐 JSON：行尾必须带换行，服务层按行解析（少了它两行会被拼成一行）
        for line in self.lines:
            yield line + "\n"
        if self.error is not None:
            raise self.error


async def _no_sleep(_delay: float) -> None:
    """测试里不真的等退避时间。"""


def _payload(char_id: str = "amber") -> dict[str, str]:
    return {"session_id": "s1", "char_id": char_id, "text": "你好"}


def _client(client: FakeClient, *, llm: LlmSettings | None = None) -> TestClient:
    service = ChatService(
        llm=llm or LlmSettings(base_url="https://api.example.com/v1", api_key="k", model="m"),
        characters_dir=CHARACTERS_DIR,
        client_factory=lambda _endpoint: cast(OpenAiChatClient, client),
        sleep=_no_sleep,
    )
    return TestClient(create_app(chat_service=service))


def _events(response: object) -> list[dict[str, object]]:
    """从 SSE 响应里取出全部 data 段并解析成事件字典。"""
    frames = [
        line
        for line in response.iter_lines()
        if isinstance(line, str) and line.startswith("data: ")
    ]
    return [json.loads(frame[len("data: ") :]) for frame in frames]


def test_event_kind_anchor_matches_ipc_contract() -> None:
    """五种事件类型是跨语言锚点，app/main/ipc.ts 的 CHAT_EVENT_KINDS 必须一致（T1.3）。"""
    assert list(LLM_EVENT_KINDS) == ["s", "m", "a", "end", "e"]


def test_stream_returns_sse_frames_ending_with_end() -> None:
    with _client(FakeClient([SENTENCE_LINE, END_LINE])) as app_client:
        with app_client.stream("POST", "/chat/stream", json=_payload()) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith(SSE_MEDIA_TYPE)
            events = _events(response)
    assert [event["t"] for event in events] == ["s", "end"]


def test_unconfigured_model_reports_error_event_and_still_ends() -> None:
    """没配模型：HTTP 仍是 200，但第一帧就是不可重试的 error 事件，最后有 end。"""
    with _client(FakeClient(), llm=LlmSettings()) as app_client:
        with app_client.stream("POST", "/chat/stream", json=_payload()) as response:
            assert response.status_code == 200
            events = _events(response)
    assert events[0]["t"] == "e"
    assert events[0]["recoverable"] is False
    assert events[-1]["t"] == "end"


def test_missing_pack_reports_error_event() -> None:
    """/chat/stream 是会话主入口：角色包不存在要在这里说清楚，而不是 500。"""
    with _client(FakeClient([SENTENCE_LINE])) as app_client:
        with app_client.stream("POST", "/chat/stream", json=_payload("__nope__")) as response:
            assert response.status_code == 200
            events = _events(response)
    assert events[0]["t"] == "e"
    assert str(events[0]["code"]).startswith("DP-PACK-")
    assert events[-1]["t"] == "end"


def test_empty_text_with_interaction_streams() -> None:
    """只有触摸、没有台词也允许（T2.3-C2c）：校验器只拦「两者都空」。"""
    payload = {
        "session_id": "s1",
        "char_id": "amber",
        "text": "",
        "interaction": {
            "gesture": "tap",
            "regions": [{"id": "head", "name": "头"}],
            "count": 2,
        },
    }
    with _client(FakeClient([SENTENCE_LINE, END_LINE])) as app_client:
        with app_client.stream("POST", "/chat/stream", json=payload) as response:
            assert response.status_code == 200
            events = _events(response)
    assert [event["t"] for event in events] == ["s", "end"]


def test_empty_text_is_rejected_before_streaming() -> None:
    """空输入且没有互动时仍在契约层被 422 拦下（text 与 interaction 不能同时为空）。"""
    with _client(FakeClient([SENTENCE_LINE])) as app_client:
        response = app_client.post(
            "/chat/stream", json={"session_id": "s1", "char_id": "amber", "text": ""}
        )
    assert response.status_code == 422
