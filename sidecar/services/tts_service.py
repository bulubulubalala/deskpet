"""文件职责：语音合成的用例层——单句长度校验、单句超时、取消语义（需求 §6.7 / §6.12）。

依赖方向：services -> adapters（适配器由组合根或 build_tts_service 注入）/ core / contracts；
不 import api。
谁调用：api/tts.py；sidecar/app.py 经 build_tts_service() 构造。

约定：
- 单句 ≤40 字（§6.2 / §6.12）：超了直接 DP-TTS-400，不替调用方切句——切句是 LLM 事件协议
  那一层的责任，这里再切会把「谁该负责」搅浑。
- 30s 单句超时是 §6.7 的硬约定（依据 §3.5：59 字切块合成实测 19.25s）。超时只影响这一句，
  **不抛到会话层**：T1.6 的状态机负责跳过它并继续。
- 引擎侧信息原样透传（D14）：本层只加「这是哪一句、花了多久」，不改引擎给的 message / hint。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol

from adapters.tts_index import IndexTtsClient, TtsEndpoint
from config import Settings
from contracts.api_models import TtsCancelResponse, TtsRequest
from contracts.errors import CODE_TTS_BAD_REQUEST, CODE_TTS_SENTENCE_TIMEOUT
from contracts.events import MAX_SENTENCE_CHARS
from core.env_events import EVENT_TTS_FAILED, EnvEventReporter
from core.errors import DeskpetError, TtsError
from core.logging import get_logger, log_event
from core.tts import CANCEL_IN_FLIGHT, CANCEL_QUEUED, TtsAudio, cancel_is_effective

LOGGER = get_logger("sidecar.services.tts_service")

#: 单句合成预算（需求 §6.7）
DEFAULT_SENTENCE_TIMEOUT_S = 30.0
USER_HINT_TOO_LONG = "这句话太长了，先切短一点再合成"
USER_HINT_TIMEOUT = "等语音引擎太久了，这句话先跳过"

#: 取消结果的人话解释，只进日志（响应里的 reason 用适配器的原词，便于对账）
_CANCEL_REASONS = {
    CANCEL_QUEUED: "排队中的句子已丢弃，没有消耗算力",
    CANCEL_IN_FLIGHT: "正在合成的那句已标记取消；真正 <200ms 的打断由播放侧立刻停播实现",
}


class TtsAdapter(Protocol):
    """用例层需要适配器提供的最小接口（真身：adapters/tts_index.py）。"""

    async def synthesize(self, request: TtsRequest) -> TtsAudio: ...

    async def cancel(self, request_id: str) -> str: ...


class TtsService:
    """一次一句话的合成用例：校验 → 限时调用 → 记录引擎侧数字。"""

    def __init__(
        self,
        tts: TtsAdapter,
        *,
        timeout_s: float = DEFAULT_SENTENCE_TIMEOUT_S,
        env: EnvEventReporter | None = None,
    ) -> None:
        self._tts = tts
        self._timeout_s = timeout_s
        # 环境事件（§6.8）：引擎出事就登记 tts.failed，角色怎么抱怨由 M4 决定
        self._env = env

    @property
    def adapter(self) -> TtsAdapter:
        """给 T1.8 资源闸门用：闸门需要拿到适配器做 load / unload（§4.4）。"""
        return self._tts

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        """合成一句；长度与超时在契约上就有明确后果（§6.7）。"""
        text = request.text.strip()
        if not text:
            raise TtsError(
                CODE_TTS_BAD_REQUEST,
                "text 不能为空",
                user_hint=USER_HINT_TOO_LONG,
                context={"request_id": request.request_id},
            )
        if len(text) > MAX_SENTENCE_CHARS:
            raise TtsError(
                CODE_TTS_BAD_REQUEST,
                "单句超过 " + str(MAX_SENTENCE_CHARS) + " 字（当前 " + str(len(text)) + "）",
                user_hint=USER_HINT_TOO_LONG,
                context={"request_id": request.request_id, "chars": len(text)},
            )
        normalized = request.model_copy(update={"text": text})
        try:
            audio = await asyncio.wait_for(
                self._tts.synthesize(normalized), timeout=self._timeout_s
            )
        except TimeoutError as exc:
            self._report_failure(CODE_TTS_SENTENCE_TIMEOUT, USER_HINT_TIMEOUT)
            raise TtsError(
                CODE_TTS_SENTENCE_TIMEOUT,
                "单句合成超过 " + str(self._timeout_s) + "s 未返回",
                user_hint=USER_HINT_TIMEOUT,
                context={"request_id": request.request_id, "chars": len(text)},
            ) from exc
        except DeskpetError as exc:
            # 适配器侧的引擎异常（D14）：错误信息原样透传，这里只补一条环境事件
            self._report_failure(exc.code, exc.user_hint or "")
            raise
        self._clear_failure()
        log_event(
            LOGGER,
            logging.INFO,
            module="services.tts_service",
            event="tts.synth",
            message="合成完成",
            fields={
                "request_id": audio.request_id,
                "chars": len(text),
                "voice": audio.voice,
                "gen_ms": audio.gen_ms,
                "audio_ms": audio.audio_ms,
                "rtf": round(audio.rtf, 3),
                "bytes": len(audio.audio),
            },
        )
        return audio

    async def cancel(self, request_id: str) -> TtsCancelResponse:
        """把 /tts/cancel 转给适配器；unknown 表示这句已经结束（正常情况，不是错误）。"""
        state = await self._tts.cancel(request_id)
        cancelled = cancel_is_effective(state)
        log_event(
            LOGGER,
            logging.INFO,
            module="services.tts_service",
            event="tts.cancelled",
            message=_CANCEL_REASONS.get(state, "该 request_id 已结束或不存在"),
            fields={"request_id": request_id, "state": state, "cancelled": cancelled},
        )
        return TtsCancelResponse(cancelled=cancelled, reason=state)

    def _report_failure(self, code: str, user_hint: str) -> None:
        """上报 tts.failed：fact 只说「合成失败 + 错误码」，排查指引走 user_hint（§6.8）。"""
        if self._env is None:
            return
        self._env.report(
            EVENT_TTS_FAILED,
            fact="语音合成失败（" + code + "）",
            user_hint=user_hint,
        )

    def _clear_failure(self) -> None:
        """成功合成一句即认为引擎恢复，撤销 tts.failed（§6.8）。"""
        if self._env is not None:
            self._env.clear(event_id=EVENT_TTS_FAILED)


def build_tts_service(settings: Settings, *, env: EnvEventReporter | None = None) -> TtsService:
    """组合根用的构造器：真适配器（HTTP 客户端）+ 配置里的超时 + 可注入的事件总线。"""
    client = IndexTtsClient(
        TtsEndpoint(
            base_url=settings.tts.base_url,
            token=settings.tts.token,
            timeout_s=settings.tts.timeout_s,
        )
    )
    return TtsService(client, timeout_s=settings.tts.timeout_s, env=env)
