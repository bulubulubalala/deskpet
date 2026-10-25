"""文件职责：OpenAI 兼容的**流式**聊天客户端——/chat/stream 的唯一出口（需求 §6.3）。

依赖方向：adapters -> contracts / core；不 import services / api。
谁调用：services/chat_service.py 注入使用；单测用 httpx.MockTransport 喂假 SSE，不联网。

为什么手写而不上 openai SDK：只用到「POST + SSE」这一条路径，SDK 会带进一整棵依赖树；
而错误码映射（§6.4）必须由我们说了算——SDK 的异常类型会把 HTTP 语义抹平。

实测坑（用户端点 deepseek/deepseek-v4.1-flash）：delta 里会先出现一大段 reasoning_content，
而 max_tokens 偏小时 content 可能整轮为空。因此**只取 content，明确忽略 reasoning_content**：
把思维链当台词读出来是灾难，把它当失败又会误判成「模型没回应」。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass

import httpx

from contracts.errors import (
    CODE_LLM_AUTH_FAILED,
    CODE_LLM_BAD_RESPONSE,
    CODE_LLM_RATE_LIMITED,
    CODE_LLM_TIMEOUT,
)
from core.errors import LlmError
from core.logging import get_logger, log_event
from core.usage import LlmUsage

LOGGER = get_logger("sidecar.adapters.llm_openai")

#: 单次 HTTP 请求的兜底超时；首 token 与总时长由 services/chat_service.py 管（§6.7）。
DEFAULT_TIMEOUT_S = 60.0
CONNECT_TIMEOUT_S = 10.0

USER_HINT_AUTH = "模型服务拒绝了这个 API key，请检查 .env 里的 DESKPET_LLM_API_KEY"
USER_HINT_RATE_LIMITED = "模型服务限流了，等一会儿再发"
USER_HINT_TIMEOUT = "模型服务响应超时，稍后再试"
USER_HINT_NETWORK = "网络不通，稍后再试"
USER_HINT_BAD_RESPONSE = "模型返回了看不懂的内容，稍后再试"

#: 响应体只留前这么多字符进日志/错误上下文，避免把整篇输出倒进日志。
_BODY_PREVIEW_CHARS = 200


@dataclass(frozen=True, slots=True)
class LlmEndpoint:
    """一个候选端点（主用 / 备用），字段与 §6.7 的三件套一一对应。"""

    base_url: str
    api_key: str
    model: str


def chat_completions_url(base_url: str) -> str:
    """拼出 chat completions 地址；base_url 末尾多写一个斜杠也不会拼出双斜杠。"""
    return base_url.rstrip("/") + "/chat/completions"


def _first_content_delta(chunk: object) -> str:
    """从一段流式 chunk 里取 choices[0].delta.content；形状不对就返回空串。

    刻意不看 reasoning_content（见模块 docstring）：宁可这一轮没词，也不读思维链。
    """
    if not isinstance(chunk, dict):
        return ""
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def _as_int(raw: object) -> int:
    return int(raw) if isinstance(raw, (int, float)) and raw >= 0 else 0


def _normalize_usage(value: object) -> LlmUsage | None:
    """把 OpenAI / DeepSeek 等常见的 usage 形状归一成 LlmUsage；不认识就返回 None。"""
    if not isinstance(value, dict):
        return None
    prompt = value.get("prompt_tokens", value.get("input_tokens", 0))
    completion = value.get("completion_tokens", value.get("output_tokens", 0))
    total = value.get("total_tokens", 0)
    cached: object = 0
    details = value.get("prompt_tokens_details")
    if isinstance(details, dict):
        cached = details.get("cached_tokens", 0)
    if not _as_int(cached):
        cached = value.get("prompt_cache_hit_tokens", value.get("cache_read_input_tokens", 0))
    prompt_i = _as_int(prompt)
    completion_i = _as_int(completion)
    return LlmUsage(
        prompt_tokens=prompt_i,
        cached_tokens=min(_as_int(cached), prompt_i) if prompt_i else _as_int(cached),
        completion_tokens=completion_i,
        total_tokens=_as_int(total) or prompt_i + completion_i,
    )


class OpenAiChatClient:
    """一次会话用一次的流式客户端（每次请求新建 httpx.AsyncClient，用完即关）。"""

    def __init__(
        self,
        endpoint: LlmEndpoint,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._timeout_s = timeout_s
        # transport 只给测试注入（httpx.MockTransport）；生产路径永远是 None
        self._transport = transport
        self._last_usage: LlmUsage | None = None

    @property
    def last_usage(self) -> LlmUsage | None:
        """最近一次流式请求归一化后的 usage；端点没上报时为 None。"""
        return self._last_usage

    async def stream_chat(self, messages: Sequence[Mapping[str, str]]) -> AsyncIterator[str]:
        """POST /chat/completions?stream=true，逐个 yield 文本增量。

        有些 OpenAI 兼容端点不认 ``stream_options``。第一次带 usage 请求若被 400/422 明确
        拒绝，就去掉该参数重试一次；因为还没产出任何文本，不会重复台词。
        """
        url = chat_completions_url(self._endpoint.base_url)
        self._last_usage = None
        base_payload: dict[str, object] = {
            "model": self._endpoint.model,
            "messages": [dict(message) for message in messages],
            "stream": True,
        }
        headers = {
            "Authorization": "Bearer " + self._endpoint.api_key,
            "Accept": "text/event-stream",
        }
        timeout = httpx.Timeout(self._timeout_s, connect=CONNECT_TIMEOUT_S)
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                for include_usage in (True, False):
                    payload = dict(base_payload)
                    if include_usage:
                        payload["stream_options"] = {"include_usage": True}
                    async with client.stream(
                        "POST", url, json=payload, headers=headers
                    ) as response:
                        if response.status_code != 200:
                            await response.aread()
                            if include_usage and self._rejects_stream_options(response):
                                log_event(
                                    LOGGER,
                                    logging.INFO,
                                    module="sidecar.adapters.llm_openai",
                                    event="llm.stream_options_unsupported",
                                    message="端点不支持 stream_options，回退为不取 usage",
                                    fields={"url": url, "status": response.status_code},
                                )
                                continue
                            raise self._http_error(response)
                        async for delta in self._iter_deltas(response):
                            yield delta
                        return
        except httpx.TimeoutException as exc:
            raise LlmError(
                CODE_LLM_TIMEOUT,
                "模型请求超时（" + type(exc).__name__ + "）",
                user_hint=USER_HINT_TIMEOUT,
                context={"url": url},
            ) from exc
        except httpx.HTTPError as exc:
            raise LlmError(
                CODE_LLM_TIMEOUT,
                "模型请求失败（" + type(exc).__name__ + "）",
                user_hint=USER_HINT_NETWORK,
                context={"url": url},
            ) from exc

    @staticmethod
    def _rejects_stream_options(response: httpx.Response) -> bool:
        """只对明确提到 stream_options 的 4xx 重试，避免把普通请求错误也发两遍。"""
        if response.status_code not in (400, 422):
            return False
        text = response.text.lower()
        return "stream_options" in text or "include_usage" in text

    def _http_error(self, response: httpx.Response) -> LlmError:
        """把非 200 映成 §6.4 的错误码（401/403/429/其它）。"""
        status = response.status_code
        body = response.text[:_BODY_PREVIEW_CHARS]
        context = {"status": status, "body": body, "url": str(response.request.url)}
        if status in (401, 403):
            return LlmError(
                CODE_LLM_AUTH_FAILED,
                "模型服务拒绝鉴权（HTTP " + str(status) + "）",
                user_hint=USER_HINT_AUTH,
                context=context,
            )
        if status == 429:
            return LlmError(
                CODE_LLM_RATE_LIMITED,
                "模型服务限流（HTTP 429）",
                user_hint=USER_HINT_RATE_LIMITED,
                context=context,
            )
        return LlmError(
            CODE_LLM_BAD_RESPONSE,
            "模型服务返回 HTTP " + str(status),
            user_hint=USER_HINT_BAD_RESPONSE,
            context=context,
        )

    async def _iter_deltas(self, response: httpx.Response) -> AsyncIterator[str]:
        """解析 SSE：只认 data: 行，遇到 [DONE] 收工；坏行跳过并记一条日志。"""
        async for line in response.aiter_lines():
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data:
                continue
            if data == "[DONE]":
                return
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                log_event(
                    LOGGER,
                    logging.DEBUG,
                    module="sidecar.adapters.llm_openai",
                    event="llm.bad_chunk",
                    message="跳过一段无法解析的 SSE 数据",
                    fields={"chars": len(data)},
                )
                continue
            if isinstance(chunk, dict):
                normalized = _normalize_usage(chunk.get("usage"))
                if normalized is not None:
                    self._last_usage = normalized
            error = chunk.get("error") if isinstance(chunk, dict) else None
            if isinstance(error, dict):
                raise LlmError(
                    CODE_LLM_BAD_RESPONSE,
                    "模型服务在流里返回错误："
                    + str(error.get("message") or error.get("code") or ""),
                    user_hint=USER_HINT_BAD_RESPONSE,
                    context={"error_code": str(error.get("code") or "")},
                )
            content = _first_content_delta(chunk)
            if content:
                yield content
