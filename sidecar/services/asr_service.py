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
from config import Settings
from contracts.api_models import AsrQuery, AsrResponse
from contracts.errors import CODE_ASR_TIMEOUT, CODE_ASR_UNAVAILABLE
from core.asr import Transcript, is_meaningful_transcript
from core.errors import AsrError
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

    def __init__(self, asr: AsrAdapter, *, timeout_s: float) -> None:
        self._asr = asr
        self._timeout_s = timeout_s

    @property
    def adapter(self) -> AsrAdapter:
        """暴露适配器给 T1.8 的资源闸门（加载 / 卸载都要经过闸门，不能各写一份）。"""
        return self._asr

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


def build_asr_service(settings: Settings) -> AsrService:
    """组合根用的构造器：真适配器 + 配置里的超时。"""
    return AsrService(FasterWhisperAsr(settings.asr), timeout_s=settings.asr.timeout_s)
