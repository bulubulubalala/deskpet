"""文件职责：语音全双工的会话编排（P2）——PCM → ASR → LLM 流 → 逐句 TTS → 音频块。

依赖方向：services -> services（注入的 Asr/Chat/Tts/Voice）+ contracts + core；不 import api。
谁调用：api/voice_ws.py 的 WebSocket 路由（每条连接一个 VoiceSession）。

与 HTTP 三条旧路由的关系：文字聊天仍走 /chat/stream + /tts（主进程编排）；语音全双工走这里，
由 sidecar 自己把「识别 → 生成 → 合成」串起来，少两次跨进程往返。**取消是一等公民**：
每一次 begin/cancel 都抬 generation，流水线在每个 await 之后检查它，过期就整段丢弃。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from contracts.api_models import EMOTION_VECTOR_SIZE, AsrQuery, ChatStreamRequest, TtsRequest
from contracts.errors import CODE_PACK_FIELD_MISSING
from contracts.events import ActEvent, EndEvent, ErrorEvent, MemoryEvent, SentenceEvent
from core.asr import AsrStream
from core.errors import DeskpetError, PackError
from core.logging import get_logger, log_event
from services.asr_service import AsrService
from services.character_store import LoadedPack, load_character_pack
from services.chat_service import ChatService
from services.tts_service import TtsService
from services.voice_service import VoiceService

LOGGER = get_logger("sidecar.services.voice_session")

#: 角色包 tts_lang → /tts 契约的三种语言（AR / ES 暂按 zh 处理，与主进程的映射一致）。
_LANG_MAP: dict[str, Literal["zh", "ja", "en"]] = {"ZH": "zh", "EN": "en", "JA": "ja"}


@dataclass(frozen=True, slots=True)
class VoiceOut:
    """一条要发给客户端的输出：要么是 JSON 事件，要么是紧随其后的音频二进制。

    为什么分开：WebSocket 的文本帧与二进制帧是两种类型；`tts.audio` 事件先发（带 request_id /
    format / seq），再发二进制本体，客户端按顺序配对即可。
    """

    event: dict[str, Any] | None = None
    audio: bytes | None = None


class VoiceSession:
    """一条 WS 连接的语音编排器；begin/cancel 抬 generation，run() 每个 await 后校验。"""

    def __init__(
        self,
        *,
        asr: AsrService,
        chat: ChatService,
        tts: TtsService,
        voice: VoiceService,
        characters_dir: Path,
    ) -> None:
        self._asr = asr
        self._chat = chat
        self._tts = tts
        self._voice = voice
        self._characters_dir = characters_dir
        self._generation = 0
        self._session_id = ""
        self._char_id = ""
        self._sample_rate = 16000
        self._seq = 0
        # 流式识别（P2）：一条语音一个 stream；begin 时新开、cancel / run 收尾时关掉
        self._stream: AsrStream | None = None
        self._last_partial = ""
        # 语音输出开关（麦克风旁的按钮）：false = 只出文字事件，不做 TTS
        self._tts_enabled = True

    # ------------------------------------------------------------ 生命周期

    async def begin(
        self,
        *,
        session_id: str,
        char_id: str,
        sample_rate: int,
        start_asr: bool = True,
        tts_enabled: bool = True,
    ) -> None:
        """开始新一轮：作废上一轮、记上下文，并按需开一条流式识别。

        start_asr=False 给「文字输入」用：那条路径不需要音频识别流，开了也只是白占资源。
        tts_enabled=False 时这一轮只出文字（llm.s），不做合成。
        """
        self._generation += 1
        self._session_id = session_id
        self._char_id = char_id
        self._sample_rate = sample_rate
        self._seq = 0
        self._last_partial = ""
        self._tts_enabled = tts_enabled
        self._close_stream()
        self._voice.listen_start()
        if not start_asr:
            return
        # 兼容「注入了只有 transcribe 的假服务 / 旧适配器」：没有 start_stream 就退回批处理
        starter = getattr(self._asr, "start_stream", None)
        if starter is None:
            return
        # 构造识别器可能要几百毫秒（首次加载模型）：别阻塞事件循环
        self._stream = await asyncio.to_thread(starter, sample_rate=sample_rate, lang=None)

    def cancel(self) -> int:
        """打断：抬 generation 并让状态机受理一次取消（在途任务由调用方 cancel）。"""
        self._generation += 1
        self._close_stream()
        self._voice.listen_stop()
        return self._voice.interrupt("duplex_cancel")

    async def accept_audio(self, pcm: bytes) -> str | None:
        """喂一块音频给流式识别；partial 有变化时返回新文本（没变化返回 None）。

        同步的 sherpa 解码放到线程里跑（RTF 约 0.02，单块只要几毫秒），
        调用方（WS 接收循环）拿到新 partial 就推一条 `asr.partial`。
        """
        stream = self._stream
        if stream is None or not pcm:
            return None
        partial = await asyncio.to_thread(self._asr.accept_stream, stream, pcm)
        if partial == self._last_partial:
            return None
        self._last_partial = partial
        return partial or None

    # ------------------------------------------------------------ 主流水线

    async def run(self, pcm: bytes, *, asr_text: str | None = None) -> AsyncIterator[VoiceOut]:
        """一次完整回合：识别（或直接给文本）→ LLM 流 → 逐句合成。

        任何一段发现 generation 变了就静默返回（客户端已经打断）；单个 TTS 失败只跳过这一句，
        不把整轮对话搞崩（§6.7 A 级降级）。
        """
        generation = self._generation
        # 收音结束：退出 listening，后面的 ASR / chat / tts 活动才能把状态推到 thinking / speaking
        self._voice.listen_stop()
        if asr_text is not None:
            # 文字输入不经过 ASR：把可能开着的识别流收掉（begin(start_asr=False) 正常不会开）
            self._close_stream()
        if asr_text is None:
            try:
                async with self._voice.activity("asr"):
                    stream = self._stream
                    if stream is not None:
                        # 流式终稿：音频块已经在 accept_audio 里喂过了，这里只收尾
                        self._stream = None
                        try:
                            result = await asyncio.to_thread(
                                self._asr.finish_stream, stream, request_id=uuid.uuid4().hex
                            )
                        finally:
                            await asyncio.to_thread(stream.close)
                    else:
                        # 没有流式引擎（或模型没就位）：退回原来的整段批处理
                        result = await self._asr.transcribe(self._asr_query(), pcm)
            except DeskpetError as exc:
                log_event(
                    LOGGER,
                    logging.WARNING,
                    module="services.voice_session",
                    event="voice.asr_failed",
                    message="语音识别失败，本轮按没听清处理",
                    code=exc.code,
                    domain=exc.domain,
                    trace=str(exc),
                )
                yield _event(
                    "error", code=exc.code, user_hint=exc.user_hint or "没听清，再说一次。"
                )
                yield _state("idle")
                return
            if generation != self._generation:
                return
            if not result.text:
                yield _event("asr.empty")
                yield _state("idle")
                return
            text = result.text
            confidence = result.confidence
            yield _event("asr.final", text=text, confidence=confidence)
        else:
            # 文字输入直接进 LLM：没有「识别结果」可回报，就不发 asr.final
            text = asr_text

        pack = self._load_pack()
        if pack is None:
            yield _event(
                "error",
                code=CODE_PACK_FIELD_MISSING,
                user_hint="找不到这个角色包，或者角色包格式有问题",
            )
            yield _state("idle")
            return

        request = ChatStreamRequest(
            session_id=self._session_id,
            char_id=self._char_id,
            text=text,
            input_mode="voice",
        )
        yield _state("thinking")
        try:
            async with self._voice.activity("chat"):
                async for event in self._chat.stream_events(request):
                    if generation != self._generation:
                        return
                    if isinstance(event, SentenceEvent):
                        yield _event(
                            "llm.s",
                            i=event.i,
                            text=event.text,
                            emotion=event.emotion,
                            intensity=event.intensity,
                            act=event.act,
                        )
                        # 语音输出关闭：只出文字事件，不合成（省算力，也让「只用文字」即时生效）
                        if self._tts_enabled:
                            async for out in self._synthesize(pack, event):
                                if generation != self._generation:
                                    return
                                yield out
                    elif isinstance(event, ActEvent):
                        yield _event("llm.a", act=event.act)
                    elif isinstance(event, MemoryEvent):
                        yield _event("llm.m", kind=event.kind, text=event.text)
                    elif isinstance(event, ErrorEvent):
                        yield _event(
                            "error",
                            code=event.code,
                            user_hint=event.user_hint,
                            recoverable=event.recoverable,
                        )
                    elif isinstance(event, EndEvent):
                        yield _event("llm.end")
        except Exception as exc:  # 兜底：WS 已经建立，不能把异常甩给客户端
            log_event(
                LOGGER,
                logging.ERROR,
                module="services.voice_session",
                event="voice.unhandled",
                message="语音流水线出现未预期异常",
                fields={"reason": type(exc).__name__, "error": str(exc)},
            )
            yield _event("error", code="DP-SYS-500", user_hint="出了点内部故障，稍后再试")
            yield _state("idle")
            return
        # 正常收尾才发 idle；被打断（generation 变了）由 api 层统一发 idle，避免在生成器
        # 被 cancel 时于 finally 里 yield（那会触发「async generator ignored GeneratorExit」）。
        if generation == self._generation:
            yield _state("idle")

    # ------------------------------------------------------------ 合成

    async def _synthesize(self, pack: LoadedPack, event: SentenceEvent) -> AsyncIterator[VoiceOut]:
        """合成一句并按块下发；失败只跳过这一句（环境事件由 TtsService 上报）。"""
        request = self._tts_request(pack, event)
        try:
            async with self._voice.activity("tts"):
                audio = await self._tts.synthesize(request)
        except DeskpetError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.voice_session",
                event="voice.tts_skipped",
                message="这一句合成失败，跳过（不影响后面的句子）",
                code=exc.code,
                domain=exc.domain,
                fields={"request_id": request.request_id, "chars": len(event.text)},
            )
            return
        self._seq += 1
        yield _state("speaking")
        yield _event(
            "tts.audio",
            request_id=audio.request_id,
            text=event.text,
            format=audio.format,
            seq=self._seq,
            final=True,
            gen_ms=audio.gen_ms,
            audio_ms=audio.audio_ms,
            rtf=audio.rtf,
        )
        yield VoiceOut(audio=audio.audio)

    def _tts_request(self, pack: LoadedPack, event: SentenceEvent) -> TtsRequest:
        """从角色包 + 台词事件拼 TtsRequest（voice_id 用参考音绝对路径，与主进程口径一致）。"""
        voice_id = ""
        if pack.voice.ref_audio:
            candidate = Path(pack.voice.ref_audio)
            if not candidate.is_absolute():
                candidate = pack.root / candidate
            if candidate.is_file():
                voice_id = str(candidate)
        return TtsRequest(
            text=event.text,
            voice_id=voice_id,
            lang=_LANG_MAP.get(pack.voice.lang.upper(), "zh"),
            emo_vector=_emotion_vector(pack, event.emotion, event.intensity),
            emo_weight=event.intensity,
            speed=pack.voice.speed,
            request_id=uuid.uuid4().hex,
        )

    # ------------------------------------------------------------ 工具

    def _asr_query(self) -> AsrQuery:
        """识别参数：采样率来自渲染层，语言留空让引擎自动判断（角色包语言不参与 ASR）。"""
        return AsrQuery(
            sample_rate=self._sample_rate,
            lang=None,
            request_id=uuid.uuid4().hex,
        )

    def _load_pack(self) -> LoadedPack | None:
        """读角色包；缺包 / 坏包返回 None（调用方转成一条 error 事件，而不是把任务炸掉）。"""
        try:
            loaded = load_character_pack(self._characters_dir / self._char_id)
        except PackError:
            return None
        return loaded if loaded.ok else None

    def _close_stream(self) -> None:
        """丢掉当前流式会话（打断 / 开新一轮）：只释放引用，sherpa 的流由 GC 回收。"""
        stream = self._stream
        self._stream = None
        self._last_partial = ""
        if stream is not None:
            stream.close()


def _emotion_vector(pack: LoadedPack, label: str | None, intensity: float) -> list[float]:
    """台词标签 → 8 维向量；未知标签给全零（与主进程 emotionVectorFor 的行为一致）。"""
    if label is None or label not in pack.emotions:
        return [0.0] * EMOTION_VECTOR_SIZE
    ratio = min(max(intensity, 0.0), 1.0)
    base = pack.emotions[label].vector
    return [round(min(max(value, 0.0), 1.0) * ratio, 4) for value in base]


def _event(event_type: str, **fields: Any) -> VoiceOut:
    return VoiceOut(event={"t": event_type, **fields})


def _state(state: str) -> VoiceOut:
    return _event("state", state=state)


__all__ = ["VoiceOut", "VoiceSession"]
