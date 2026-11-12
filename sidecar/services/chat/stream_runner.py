"""文件职责：一次模型调用的流式编排——多端点降级、退避重试、两段超时、断流收尾（§6.7）。

为什么单独一层：这段代码只跟「模型怎么回话」有关，跟角色包、记忆怎么写、统计怎么落库
无关；拆出来之后，重试规则可以脱离整套记忆依赖单独思考与测试。

三条硬规则（不许改坏）：
- 重试只在「本轮还没产出任何事件」时发生；已经播出去的台词照常播完，绝不重播上一句；
- 首 token 20s、整体 60s 是硬超时，超时与断网都要变成可读的 ErrorEvent；
- 任何失败都以 ErrorEvent + EndEvent 收尾，HTTP 层已经发过 200，不能靠抛异常表达。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services/chat/service.py 的 ChatService.stream_events()。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Sequence

from adapters.llm_openai import (
    USER_HINT_BAD_RESPONSE,
    USER_HINT_NETWORK,
    USER_HINT_TIMEOUT,
    LlmEndpoint,
    OpenAiChatClient,
)
from config import LlmSettings
from contracts.api_models import ChatStreamRequest
from contracts.errors import CODE_LLM_BAD_RESPONSE, CODE_LLM_TIMEOUT
from contracts.events import EndEvent, ErrorEvent, LlmEvent
from core.env_events import EVENT_NET_DOWN, EnvEventReporter
from core.error_detail import build_error_detail, detail_log_fields
from core.errors import LlmError
from core.logging import get_logger, log_event
from core.usage import LlmUsage, UsageRecorder
from services.chat.line_parser import is_open_json, parse_line
from services.llm_ports import ClientFactory, Sleep

LOGGER = get_logger("sidecar.services.chat")


class ChatStreamRunner:
    """把一个「端点 + 消息」变成事件流；重试、降级、超时都在这里，别处不用重复关心。"""

    def __init__(
        self,
        *,
        llm: LlmSettings,
        client_factory: ClientFactory,
        sleep: Sleep,
        usage: UsageRecorder | None = None,
        env: EnvEventReporter | None = None,
    ) -> None:
        self._llm = llm
        self._client_factory = client_factory
        self._sleep = sleep
        # 使用统计（§6.9）：记事实而不落盘，写盘时机由 UsageService 决定；None = 不记录
        self._usage = usage
        # 环境事件（§6.8）：断网登记 net.down，恢复即撤销；None = 不上报
        self._env = env

    async def stream_with_fallback(
        self,
        endpoints: Sequence[tuple[LlmEndpoint, str]],
        messages: Sequence[dict[str, str]],
        request: ChatStreamRequest,
        *,
        memory_tokens: int = 0,
    ) -> AsyncIterator[LlmEvent]:
        """逐个端点、逐次退避地尝试；失败要么重试（尚未产出事件），要么如实收尾。"""
        delays = self._llm.retry_delays_s
        last_error: LlmError | None = None
        attempts_used = 0
        last_endpoint = ""
        last_model = ""
        for endpoint, provider_label in endpoints:
            for attempt in range(len(delays) + 1):
                if attempt > 0:
                    delay = delays[attempt - 1]
                    log_event(
                        LOGGER,
                        logging.INFO,
                        module="sidecar.services.chat",
                        event="chat.retry",
                        message="模型请求失败，退避后重试",
                        code=last_error.code if last_error else None,
                        fields={"attempt": attempt, "delay_s": delay},
                    )
                    await self._sleep(delay)
                attempts_used += 1
                last_endpoint = endpoint.base_url
                last_model = endpoint.model
                emitted = False
                try:
                    async for event in self._stream_once(
                        endpoint, messages, request, memory_tokens=memory_tokens
                    ):
                        emitted = True
                        yield event
                    self._clear_net_error()
                    self._record_provider(request.session_id, provider_label)
                    return
                except LlmError as exc:
                    last_error = exc
                    self._report_net_error(exc)
                except TimeoutError:
                    last_error = LlmError(
                        CODE_LLM_TIMEOUT, "模型首 token / 总时长超时", user_hint=USER_HINT_TIMEOUT
                    )
                detail = build_error_detail(
                    last_error,
                    attempts=attempts_used,
                    endpoint=last_endpoint,
                    model=last_model,
                )
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="sidecar.services.chat",
                    event="chat.attempt_failed",
                    message="这一次模型请求失败",
                    code=last_error.code,
                    domain=last_error.domain,
                    trace=str(last_error),
                    fields={
                        "emitted": emitted,
                        "base_url": endpoint.base_url,
                        **detail_log_fields(detail),
                    },
                )
                if emitted:
                    # 已经播出去的内容不能收回，也绝不重播上一句（§6.7）
                    log_event(
                        LOGGER,
                        logging.WARNING,
                        module="sidecar.services.chat",
                        event="chat.interrupted",
                        message="流中断在产出之后，直接收尾",
                        code=last_error.code,
                    )
                    yield ErrorEvent(
                        code=last_error.code,
                        user_hint=last_error.user_hint or USER_HINT_NETWORK,
                        recoverable=True,
                        detail=detail,
                    )
                    yield EndEvent()
                    return

        final = last_error or LlmError(
            CODE_LLM_BAD_RESPONSE, "模型没有返回任何内容", user_hint=USER_HINT_BAD_RESPONSE
        )
        detail = build_error_detail(
            final, attempts=attempts_used, endpoint=last_endpoint, model=last_model
        )
        log_event(
            LOGGER,
            logging.ERROR,
            module="sidecar.services.chat",
            event="chat.failed",
            message="所有端点与重试都用尽",
            code=final.code,
            domain=final.domain,
            fields=detail_log_fields(detail),
        )
        yield ErrorEvent(
            code=final.code,
            user_hint=final.user_hint or USER_HINT_NETWORK,
            recoverable=True,
            detail=detail,
        )
        yield EndEvent()

    def _record_provider(self, session_id: str, name: str) -> None:
        """记下本轮**实际用上**的模型供给（§6.13：usage.db 的 llm_provider 列）。

        在主用失败、切到备用或另一个 provider 之后回填，所以事后能看出「这一轮切过供给」。
        """
        if self._usage is not None:
            self._usage.record_provider(session_id, name)

    def _report_net_error(self, error: LlmError) -> None:
        """把「连不上模型服务」登记成 net.down；端点没配 / 鉴权错不算断网。"""
        if self._env is None or not is_network_error(error):
            return
        self._env.report(
            EVENT_NET_DOWN,
            fact="连不上模型服务（网络不通）",
            user_hint=error.user_hint or USER_HINT_NETWORK,
        )

    def _clear_net_error(self) -> None:
        """这一轮有内容产出即认为网络恢复，撤销 net.down（§6.8）。"""
        if self._env is not None:
            self._env.clear(event_id=EVENT_NET_DOWN)

    async def _stream_once(
        self,
        endpoint: LlmEndpoint,
        messages: Sequence[dict[str, str]],
        request: ChatStreamRequest,
        *,
        memory_tokens: int = 0,
    ) -> AsyncIterator[LlmEvent]:
        """单个端点的一次尝试：把文本增量解析成事件，并以 EndEvent 收尾。"""
        client = self._client_factory(endpoint)
        # 真实客户端支持会话头；测试里的假客户端没有这个方法，getattr 兜底即可。
        set_session = getattr(client, "set_session_id", None)
        if callable(set_session):
            set_session(request.session_id)
        buffer = ""
        pending = ""
        index = 0
        produced = False
        fallback_logged = False
        ended = False
        end_event: EndEvent | None = None
        async for delta in self._iterate_deltas(client, messages):
            buffer += delta
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if pending:
                    line = pending + "\n" + line
                    pending = ""
                if is_open_json(line):
                    # 模型偶尔把一条事件写成多行（缩进过的 JSON）：攒到闭合再解析，
                    # 否则每一行都会被当成台词念出来（真机上见过花括号被念给用户）。
                    pending = line
                    continue
                events, index, fallback_logged = parse_line(line, index, fallback_logged)
                for event in events:
                    produced = True
                    if isinstance(event, EndEvent):
                        log_event(
                            LOGGER,
                            logging.INFO,
                            module="sidecar.services.chat",
                            event="chat.end",
                            message="本轮回复结束",
                            fields={"session_id": request.session_id, "sentences": index},
                        )
                        end_event = event
                        ended = True
                        continue
                    if not ended:
                        yield event
        leftover = pending + "\n" + buffer if pending else buffer
        if not ended:
            events, index, fallback_logged = parse_line(leftover, index, fallback_logged)
            for event in events:
                produced = True
                if isinstance(event, EndEvent):
                    end_event = event
                    ended = True
                    continue
                if not ended:
                    yield event
        if self._usage is not None:
            used = getattr(client, "last_usage", None)
            recorder = getattr(self._usage, "record_llm_usage", None)
            if isinstance(used, LlmUsage) and callable(recorder):
                recorder(request.session_id, used, memory_tokens=memory_tokens)
        if not produced:
            # 流正常结束但一个事件都没有：多半是端点不认 stream=true（回了非 SSE 报文）
            raise LlmError(
                CODE_LLM_BAD_RESPONSE,
                "模型流结束了但没有任何内容",
                user_hint=USER_HINT_BAD_RESPONSE,
                context={"base_url": endpoint.base_url},
            )
        if end_event is None:
            log_event(
                LOGGER,
                logging.INFO,
                module="sidecar.services.chat",
                event="chat.end",
                message="模型流结束但没收到 end 事件，由服务层补一个",
                fields={"session_id": request.session_id, "sentences": index},
            )
            end_event = EndEvent()
        yield end_event

    async def _iterate_deltas(
        self,
        client: OpenAiChatClient,
        messages: Sequence[dict[str, str]],
    ) -> AsyncIterator[str]:
        """带两段超时地消费模型流：首 token 用 first_token_timeout_s，其后受总时长约束。

        超时统一转成 LlmError（DP-LLM-003），让上层按 §6.7 决定重试还是收尾。
        """
        stream = client.stream_chat(messages)
        iterator = stream.__aiter__()
        deadline = time.monotonic() + self._llm.total_timeout_s
        first = True
        try:
            while True:
                if first:
                    budget = self._llm.first_token_timeout_s
                else:
                    budget = max(deadline - time.monotonic(), 0.001)
                try:
                    delta = await asyncio.wait_for(iterator.__anext__(), budget)
                except StopAsyncIteration:
                    return
                except TimeoutError as exc:
                    raise LlmError(
                        CODE_LLM_TIMEOUT,
                        "模型首 token 超时" if first else "模型响应超过总时长上限",
                        user_hint=USER_HINT_TIMEOUT,
                        context={"first_token": first},
                    ) from exc
                first = False
                yield delta
        finally:
            # stream_chat 声明的返回类型是 AsyncIterator，实际的异步生成器多一个 aclose；
            # 用 getattr 兜底，既关得掉流，也不给类型检查制造假接口。
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()


def is_network_error(error: LlmError) -> bool:
    """适配器把 httpx 连接层错误标成 DP-LLM-003 + 网络提示（adapters/llm_openai.py）。

    只认这一种组合：超时（首 token / 总时长）同样是 DP-LLM-003，但它不是「断网」，
    不该让角色说「我联系不上外面的脑子」。
    """
    return error.code == CODE_LLM_TIMEOUT and error.user_hint == USER_HINT_NETWORK


__all__ = ["ChatStreamRunner", "is_network_error"]
