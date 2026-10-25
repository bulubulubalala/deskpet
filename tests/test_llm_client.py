"""文件职责：单测 adapters/llm_openai.py 的 SSE 解析与错误码映射（需求 §6.4 / §6.7）。

依赖方向：tests -> adapters / contracts.errors / core.errors + httpx.MockTransport；不联网。
谁调用：pytest。

为什么用 MockTransport 而不是真端点：错误码路径（401 / 429 / 超时 / 流内 error）在真端点上
几乎无法按需复现，而这四条恰恰是用户最常看到的红字来源。
"""

import json
from collections.abc import Callable, Sequence

import httpx
import pytest
from adapters.llm_openai import (
    USER_HINT_NETWORK,
    LlmEndpoint,
    OpenAiChatClient,
    chat_completions_url,
)
from contracts.errors import (
    CODE_LLM_AUTH_FAILED,
    CODE_LLM_BAD_RESPONSE,
    CODE_LLM_RATE_LIMITED,
    CODE_LLM_TIMEOUT,
)
from core.errors import LlmError

ENDPOINT = LlmEndpoint(
    base_url="https://api.example.com/v1", api_key="sk-test", model="test-model"
)
MESSAGES: list[dict[str, str]] = [{"role": "user", "content": "你好"}]

Handler = Callable[[httpx.Request], httpx.Response]


def _chunk(
    content: str | None = None, reasoning: str | None = None
) -> dict[str, object]:
    """造一段 OpenAI 兼容的流式 chunk；reasoning 用来复现用户端点的思维链形态。"""
    delta: dict[str, object] = {}
    if content is not None:
        delta["content"] = content
    if reasoning is not None:
        delta["reasoning_content"] = reasoning
    return {"choices": [{"delta": delta}]}


def _sse_body(chunks: Sequence[object], *, done: bool = True) -> str:
    lines = ["data: " + json.dumps(chunk, ensure_ascii=False) for chunk in chunks]
    if done:
        lines.append("data: [DONE]")
    return "\n\n".join(lines) + "\n\n"


def _client(handler: Handler) -> OpenAiChatClient:
    return OpenAiChatClient(ENDPOINT, transport=httpx.MockTransport(handler))


async def _collect(client: OpenAiChatClient) -> list[str]:
    return [delta async for delta in client.stream_chat(MESSAGES)]


def test_chat_completions_url_trims_trailing_slash() -> None:
    assert chat_completions_url("https://a/v1") == "https://a/v1/chat/completions"
    assert chat_completions_url("https://a/v1/") == "https://a/v1/chat/completions"


async def test_streams_content_deltas_and_sends_expected_request() -> None:
    """正常流：逐段产出 content，请求带 Bearer 头与 stream=true。"""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, text=_sse_body([_chunk("你好"), _chunk("，世界")]))

    deltas = await _collect(_client(handler))
    assert deltas == ["你好", "，世界"]
    assert captured["url"] == "https://api.example.com/v1/chat/completions"
    assert captured["auth"] == "Bearer sk-test"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["model"] == "test-model"
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}


async def test_retries_without_stream_options_when_endpoint_rejects_it() -> None:
    """兼容端点明确拒绝 stream_options：去掉参数重试，台词不受影响。"""
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if "stream_options" in body:
            return httpx.Response(
                400,
                text='{"error":{"message":"Unrecognized request argument: stream_options"}}',
            )
        return httpx.Response(200, text=_sse_body([_chunk("你好")]))

    deltas = await _collect(_client(handler))
    assert deltas == ["你好"]
    assert len(bodies) == 2
    assert "stream_options" in bodies[0]
    assert "stream_options" not in bodies[1]


async def test_normalizes_final_usage_chunk() -> None:
    """OpenAI / DeepSeek 的最终 usage chunk 不进台词，但要留给统计层。"""
    usage_chunk = {
        "choices": [],
        "usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 80,
            "total_tokens": 1280,
            "prompt_tokens_details": {"cached_tokens": 900},
        },
    }
    client = _client(
        lambda _request: httpx.Response(
            200, text=_sse_body([_chunk("你好"), usage_chunk])
        )
    )
    assert await _collect(client) == ["你好"]
    assert client.last_usage is not None
    assert client.last_usage.prompt_tokens == 1200
    assert client.last_usage.cached_tokens == 900
    assert client.last_usage.completion_tokens == 80
    assert client.last_usage.total_tokens == 1280


async def test_reasoning_content_is_ignored() -> None:
    """用户端点先吐思维链：绝不能把思维链当台词读出来，也不能因此判定失败。"""
    chunks = [_chunk(reasoning="让我想想"), _chunk(reasoning="再想想")]
    assert (
        await _collect(
            _client(lambda _request: httpx.Response(200, text=_sse_body(chunks)))
        )
        == []
    )


async def test_broken_json_line_is_skipped() -> None:
    """坏行跳过，其余照常产出——一行坏数据不该毁掉整轮回复。"""
    body = (
        "data: {不是 JSON\n\ndata: " + json.dumps(_chunk("好")) + "\n\ndata: [DONE]\n\n"
    )
    deltas = await _collect(_client(lambda _request: httpx.Response(200, text=body)))
    assert deltas == ["好"]


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [
        (401, CODE_LLM_AUTH_FAILED),
        (403, CODE_LLM_AUTH_FAILED),
        (429, CODE_LLM_RATE_LIMITED),
    ],
)
async def test_http_status_maps_to_error_code(status: int, expected_code: str) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "nope"}})

    with pytest.raises(LlmError) as info:
        await _collect(_client(handler))
    assert info.value.code == expected_code


async def test_unexpected_status_maps_to_bad_response() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    with pytest.raises(LlmError) as info:
        await _collect(_client(handler))
    assert info.value.code == CODE_LLM_BAD_RESPONSE


async def test_stream_error_object_raises_bad_response() -> None:
    """有的网关把错误写在流里而不是 HTTP 状态上，同样必须转成错误码。"""
    body = (
        "data: "
        + json.dumps({"error": {"code": "internal", "message": "boom"}})
        + "\n\n"
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body)

    with pytest.raises(LlmError) as info:
        await _collect(_client(handler))
    assert info.value.code == CODE_LLM_BAD_RESPONSE


async def test_connect_error_maps_to_network_hint() -> None:
    """连不上（DNS / 隧道 / 代理挂掉）要说「网络不通」，而不是含糊的未知错误。"""

    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("tunnel broke")

    with pytest.raises(LlmError) as info:
        await _collect(_client(handler))
    assert info.value.code == CODE_LLM_TIMEOUT
    assert info.value.user_hint == USER_HINT_NETWORK
