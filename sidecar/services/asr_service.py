"""文件职责：ASR 用例层——超时、空/幻听判定与响应组装（需求 §6.3 / §6.7 / §5 F2）。

依赖方向：services -> adapters（适配器由组合根或 build_asr_service 注入）/ core / contracts；
不 import api。
谁调用：api/asr.py；sidecar/app.py 经 build_asr_service() 构造。
约定：
- 15s 超时是 §6.7 的硬约定（依据 §3.5：59 字切块合成实测 19.25s，识别同样必须有上限）；
  **模型加载不计入这 15s**——真机首次从磁盘加载 small（464MB）就超过 15s，算进去会让
  「开机后第一次说话」必然报超时；加载单独给一个宽松上限（LOAD_TIMEOUT_S）。
- 空 / 幻听文本返回 text="" 且 confidence=0，**由调用方（T1.6 状态机）转成「没听清，再说一次」**；
  这个响应永远不进 /chat/stream——「不把幻觉喂给 LLM」是 §6.7 的明文要求。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol

from adapters.asr_faster_whisper import FasterWhisperAsr
from adapters.asr_openai import OpenAiAsr, OpenAiAsrEndpoint
from adapters.asr_stream_sherpa import SherpaStreamingAsr
from config import PROVIDER_CLOUD, PROVIDER_LOCAL, Settings
from contracts.api_models import AsrQuery, AsrResponse
from contracts.errors import CODE_ASR_TIMEOUT, CODE_ASR_UNAVAILABLE
from core.asr import AsrStream, StreamingAsr, Transcript, is_meaningful_transcript
from core.env_events import EVENT_ASR_EMPTY, EnvEventReporter
from core.errors import AsrError, DeskpetError
from core.logging import get_logger, log_event

LOGGER = get_logger("services.asr_service")

LOAD_TIMEOUT_S = 120.0
"""模型加载的宽松上限（秒）：不算进识别预算，只用来防「加载永久卡死」。"""


class AsrAdapter(Protocol):
    """service 需要适配器提供的最小接口（真身：adapters/asr_faster_whisper.py）。"""

    @property
    def is_loaded(self) -> bool: ...

    def load(self) -> None: ...

    def unload(self) -> None: ...

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript: ...


class AsrService:
    """一次识别的完整用例：空音频 → 超时 → 空/幻听 → 正常结果。"""

    def __init__(
        self,
        asr: AsrAdapter,
        *,
        timeout_s: float,
        env: EnvEventReporter | None = None,
        stream: StreamingAsr | None = None,
    ) -> None:
        self._asr = asr
        self._timeout_s = timeout_s
        # 环境事件（§6.8）：asr.empty 只登记事实，怎么表现是 M4 装配层的事
        self._env = env
        # 流式识别（P2）：模型缺失 / 依赖缺失时会在第一次 start_stream 失败并永久降级回批处理
        self._stream = stream
        self._stream_disabled = False

    @property
    def adapter(self) -> AsrAdapter:
        """暴露适配器给 T1.8 的资源闸门（加载 / 卸载都要经过闸门，不能各写一份）。"""
        return self._asr

    def start_stream(self, *, sample_rate: int, lang: str | None = None) -> AsrStream | None:
        """开一条流式识别；没配流式引擎 / 第一次就失败 → None（调用方走批处理）。

        为什么把失败吞掉：语音全双工的价值是「能说话」，流式只是体验增强；模型没下、
        sherpa 没装都不该让整条语音链断掉。失败只记一条 WARNING，之后不再重试。
        """
        if self._stream is None or self._stream_disabled:
            return None
        try:
            return self._stream.start_stream(sample_rate=sample_rate, lang=lang)
        except DeskpetError as exc:
            self._stream_disabled = True
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.asr_service",
                event="asr.stream_unavailable",
                message="流式识别不可用，自动退回批处理",
                code=exc.code,
                domain=exc.domain,
                trace=str(exc),
            )
            return None

    def accept_stream(self, stream: AsrStream, pcm: bytes) -> str:
        """喂一块音频给流式识别，返回当前 partial（同步；调用方用 to_thread 包）。"""
        return stream.accept(pcm)

    def finish_stream(self, stream: AsrStream, *, request_id: str) -> AsrResponse:
        """流式收尾 → 终稿；空 / 幻听与批处理走同一套过滤（§6.7）。"""
        result = stream.finish()
        if not is_meaningful_transcript(result.text, duration_s=result.duration_s):
            self._log_empty(
                request_id,
                reason="not_meaningful",
                duration_s=result.duration_s,
                chars=len(result.text),
            )
            return AsrResponse(
                text="",
                confidence=0.0,
                duration_s=result.duration_s,
                language=result.language,
            )
        self._clear_empty()
        return AsrResponse(
            text=result.text,
            confidence=result.confidence,
            duration_s=result.duration_s,
            language=result.language,
        )

    async def transcribe(self, query: AsrQuery, pcm: bytes) -> AsrResponse:
        """识别一段 PCM；任何「没听到人话」的情况都返回空文本而不是抛错（§6.7）。"""
        if not pcm:
            self._log_empty(query.request_id, reason="empty_body", duration_s=0.0, chars=0)
            return AsrResponse(text="", confidence=0.0, duration_s=0.0, language=query.lang)
        await self._ensure_loaded(query.request_id)
        try:
            result = await asyncio.wait_for(
                self._asr.transcribe(pcm, sample_rate=query.sample_rate, lang=query.lang),
                timeout=self._timeout_s,
            )
        except TimeoutError as exc:
            raise AsrError(
                CODE_ASR_TIMEOUT,
                f"识别超过 {self._timeout_s:g}s 未返回",
                user_hint="识别卡住了，再说一次试试。",
                context={"request_id": query.request_id, "timeout_s": self._timeout_s},
            ) from exc
        if not is_meaningful_transcript(result.text, duration_s=result.duration_s):
            self._log_empty(
                query.request_id,
                reason="not_meaningful",
                duration_s=result.duration_s,
                chars=len(result.text),
            )
            return AsrResponse(
                text="",
                confidence=0.0,
                duration_s=result.duration_s,
                language=result.language,
            )
        self._clear_empty()
        return AsrResponse(
            text=result.text,
            confidence=result.confidence,
            duration_s=result.duration_s,
            language=result.language,
        )

    async def _ensure_loaded(self, request_id: str) -> None:
        """先装好模型，再开始算识别时间。

        为什么单独一步：加载是启动成本（首次从磁盘读 464MB 模型 > 15s），不是识别延迟；
        T1.8 的资源闸门会尽量提前 /load，这里只是「没预加载也能用」的兜底。
        """
        if self._asr.is_loaded:
            return
        try:
            await asyncio.wait_for(asyncio.to_thread(self._asr.load), timeout=LOAD_TIMEOUT_S)
        except TimeoutError as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                f"ASR 模型加载超过 {LOAD_TIMEOUT_S:g}s 未完成",
                user_hint="语音识别模型加载太久了，检查模型目录或网络后再试。",
                context={"request_id": request_id, "load_timeout_s": LOAD_TIMEOUT_S},
            ) from exc

    def _log_empty(self, request_id: str, *, reason: str, duration_s: float, chars: int) -> None:
        """「没听到人话」不是错误，是要留痕的事实（§6.8 的 asr.empty 事件源就在这里）。"""
        self._report_empty(reason)
        log_event(
            LOGGER,
            logging.INFO,
            module="services.asr_service",
            event="asr.empty",
            message="没有可用的识别结果",
            fields={
                "request_id": request_id,
                "reason": reason,
                "duration_s": round(duration_s, 3),
                "chars": chars,
            },
        )

    def _report_empty(self, reason: str) -> None:
        """上报 asr.empty：事实进 fact，提示进 user_hint，两者分道走（§6.8）。"""
        if self._env is None:
            return
        self._env.report(
            EVENT_ASR_EMPTY,
            fact="这一轮没听清用户说话（原因：" + reason + "）",
            user_hint="没听清，再说一次。",
        )

    def _clear_empty(self) -> None:
        """识别成功后撤销 asr.empty：条件恢复，不必等 ttl 过期（§6.8）。"""
        if self._env is not None:
            self._env.clear(event_id=EVENT_ASR_EMPTY)


class UnavailableAsrAdapter:
    """provider 选了未知值时的兜底占位（正常路径不会走到：config 已在启动时校验）。

    与 T1.14 不同，云端识别现在有真实现（adapters/asr_openai.py）；这里只防「配置绕过了
    校验层」这种不可能的情况，行为仍是明确报错而不是静默改道本地。
    """

    def __init__(self, provider: str) -> None:
        self._provider = provider

    def _unavailable(self) -> AsrError:
        return AsrError(
            CODE_ASR_UNAVAILABLE,
            "未知的 ASR provider（provider=" + self._provider + "）",
            user_hint="识别来源不合法，请把 DESKPET_ASR_PROVIDER 设成 local 或 cloud。",
        )

    @property
    def is_loaded(self) -> bool:
        """永远没加载过任何模型。"""
        return False

    def load(self) -> None:
        raise self._unavailable()

    def unload(self) -> None:
        """没加载过东西，卸载是空操作。"""

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        raise self._unavailable()


def build_asr_service(settings: Settings, *, env: EnvEventReporter | None = None) -> AsrService:
    """组合根用的构造器：按 provider 选适配器 + 配置里的超时 + 可注入的事件总线。

    local → 本机 faster-whisper（D4）；cloud → OpenAI 兼容转录端点（T2.4，Groq / OpenAI / Azure）。
    """
    adapter: AsrAdapter
    if settings.asr.provider == PROVIDER_LOCAL:
        adapter = FasterWhisperAsr(settings.asr)
    elif settings.asr.provider == PROVIDER_CLOUD:
        adapter = OpenAiAsr(
            OpenAiAsrEndpoint(
                base_url=settings.asr.cloud_base_url,
                api_key=settings.asr.cloud_api_key,
                model=settings.asr.cloud_model,
                timeout_s=settings.asr.timeout_s,
            )
        )
    else:
        adapter = UnavailableAsrAdapter(settings.asr.provider)
    # 流式识别只在「本地 + 开关打开」时接；模型缺失会在 start_stream 首次失败后降级回批处理
    stream: StreamingAsr | None = None
    if settings.asr.provider == PROVIDER_LOCAL and settings.asr.streaming_enabled:
        stream = SherpaStreamingAsr(settings.asr)
    return AsrService(adapter, timeout_s=settings.asr.timeout_s, env=env, stream=stream)
