"""文件职责：faster-whisper 本地语音识别适配器（需求 §5 F2 / §2 D4：本地 CPU + int8，不抢显存）。

依赖方向：adapters 实现 core 定义的类型与 services 需要的接口；不 import api / services。
谁调用：services/asr_service.py 经注入拿到它；sidecar/app.py 在组合根构造。
约定：
- 模型**懒加载**：构造适配器不碰磁盘、不碰模型，第一次 transcribe 才加载（心跳不受影响，§6.3）。
- 加载 / 卸载单独成方法，供 T1.8 的推理资源闸门做「空闲卸载、用完再载」。
- faster-whisper **不在模块顶层 import**：顶层 import 会让「没装它」的环境连 /health 都起不来，
  与 §6.7「任何一路失败都不能让角色哑掉」相悖。代价是错误只能靠异常类型翻译，所以这里把
  ImportError / OSError 都翻成 DP-ASR-004，并给出可执行的排查指引。
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
from collections.abc import Callable, Iterable
from typing import Protocol, cast

import numpy as np
from numpy.typing import NDArray

from config import AsrSettings
from contracts.errors import CODE_ASR_BAD_AUDIO, CODE_ASR_DEVICE_BUSY, CODE_ASR_UNAVAILABLE
from core.asr import Transcript, normalize_transcript
from core.errors import AsrError
from core.logging import get_logger, log_event

LOGGER = get_logger("adapters.asr_faster_whisper")

#: 16-bit 小端单声道（渲染层用 AudioWorklet 直接给这个格式，§3.4 不依赖 ffmpeg）
PCM_SAMPLE_WIDTH_BYTES = 2
#: int16 满量程是 32768 个刻度（-32768..32767），用 32768.0 归一化到 [-1, 1]
INT16_SCALE = 32768.0
#: avg_logprob 的下限：低于 -20 的概率已经没有意义，钳住避免 exp 下溢出成 0 以外的怪值
MIN_AVG_LOGPROB = -20.0


class _SegmentLike(Protocol):
    """模型返回的一个语音分段：适配器只用到这四个字段（假模型照此实现即可）。"""

    text: str
    avg_logprob: float
    start: float
    end: float


class _ModelLike(Protocol):
    """faster-whisper 的 WhisperModel 里适配器真正用到的那一个方法。"""

    def transcribe(
        self, audio: object, **kwargs: object
    ) -> tuple[Iterable[_SegmentLike], object]: ...


ModelFactory = Callable[[AsrSettings], _ModelLike]


def build_whisper_model(settings: AsrSettings) -> _ModelLike:
    """真正构造 WhisperModel（唯一 import faster-whisper 的地方）。

    hf_endpoint 非空时写进 HF_ENDPOINT——国内直连 huggingface.co 常常超时，
    这个开关让「模型下载不下来」有一个不用改代码的出口（需求 §6.7 的排查指引）。
    """
    if settings.hf_endpoint:
        os.environ["HF_ENDPOINT"] = settings.hf_endpoint
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    from faster_whisper import WhisperModel

    # faster-whisper 没有类型标注（无 py.typed），构造结果只能是 Any；它是否满足 _ModelLike
    # 由运行期决定。用 cast 把「我们知道它形状对」写清楚，而不是让 Any 从函数里漏出去
    return cast(
        _ModelLike,
        WhisperModel(
            settings.model,
            device=settings.device,
            compute_type=settings.compute_type,
            download_root=str(settings.model_dir),
        ),
    )


def decode_pcm16(pcm: bytes) -> NDArray[np.float32]:
    """16-bit 小端单声道 PCM → float32（[-1, 1]）。

    奇数长度的尾巴直接丢掉：半个采样点定格不了，丢一个字节比抛异常更符合「先把话说出来」。
    """
    usable = len(pcm) - (len(pcm) % PCM_SAMPLE_WIDTH_BYTES)
    if usable == 0:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(pcm[:usable], dtype="<i2").astype(np.float32)
    return samples / np.float32(INT16_SCALE)


class FasterWhisperAsr:
    """本地 ASR：懒加载模型 + 线程池推理（事件循环只等结果，不做重活）。"""

    def __init__(self, settings: AsrSettings, *, model_factory: ModelFactory | None = None) -> None:
        self._settings = settings
        self._model_factory = model_factory or build_whisper_model
        self._model: _ModelLike | None = None

    @property
    def is_loaded(self) -> bool:
        """模型是否已在内存里（/health 与资源闸门都关心这个）。"""
        return self._model is not None

    def load(self) -> None:
        """加载模型；幂等。

        失败一律翻译成 DP-ASR-004 并带上排查指引——缺模型又没指引，用户没法自救。
        """
        if self._model is not None:
            return
        try:
            self._model = self._model_factory(self._settings)
        except ImportError as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "faster-whisper 未安装：" + str(exc),
                user_hint="本机语音识别组件缺失（faster-whisper 未安装），先用文字聊吧。",
                context={"model": self._settings.model, "kind": "import"},
            ) from exc
        except (OSError, RuntimeError, ValueError) as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                f"加载 ASR 模型失败（{self._settings.model}）：{exc}",
                user_hint=(
                    "语音识别模型没准备好（可能是首次下载失败）。检查网络后重启应用；"
                    "国内可在 .env 里设 DESKPET_ASR_HF_ENDPOINT=https://hf-mirror.com。"
                ),
                context={"model": self._settings.model, "kind": "load"},
            ) from exc
        log_event(
            LOGGER,
            logging.INFO,
            module="adapters.asr_faster_whisper",
            event="asr.model_loaded",
            message="ASR 模型已加载",
            fields={
                "model": self._settings.model,
                "device": self._settings.device,
                "compute_type": self._settings.compute_type,
            },
        )

    def unload(self) -> None:
        """丢掉模型引用（T1.8 空闲卸载用）；真模型对象交给 GC。"""
        if self._model is None:
            return
        self._model = None
        log_event(
            LOGGER,
            logging.INFO,
            module="adapters.asr_faster_whisper",
            event="asr.model_unloaded",
            message="ASR 模型已卸载",
            fields={"model": self._settings.model},
        )

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        """识别一段 PCM：加载与推理都在线程里跑，事件循环不阻塞。

        sample_rate 只用于日志与自检（faster-whisper 的 numpy 输入默认 16kHz，
        渲染层必须按 16kHz 采集；采样率不符会在日志里留痕，便于查「听不清」的原因）。
        """
        if not pcm:
            raise AsrError(
                CODE_ASR_BAD_AUDIO,
                "PCM 请求体为空",
                user_hint="没听清，再说一次",
                context={"request_sample_rate": sample_rate},
            )
        audio = decode_pcm16(pcm)
        if audio.size == 0:
            raise AsrError(
                CODE_ASR_BAD_AUDIO,
                "PCM 长度不足一个采样点",
                user_hint="没听清，再说一次",
                context={"bytes": len(pcm)},
            )
        await asyncio.to_thread(self.load)
        model = self._model
        if model is None:  # 理论不可达；显式兜底避免「NoneType 没有 transcribe」
            raise AsrError(CODE_ASR_UNAVAILABLE, "ASR 模型未加载", user_hint="语音识别没准备好")
        wanted = lang or self._settings.language or None
        return await asyncio.to_thread(self._transcribe_sync, model, audio, wanted, sample_rate)

    def _transcribe_sync(
        self,
        model: _ModelLike,
        audio: NDArray[np.float32],
        language: str | None,
        sample_rate: int,
    ) -> Transcript:
        """线程里的真活：跑推理、收集分段、算置信度（不做任何 IO）。"""
        try:
            segments, info = model.transcribe(
                audio,
                language=language,
                beam_size=self._settings.beam_size,
                vad_filter=self._settings.vad_filter,
                condition_on_previous_text=False,
            )
            collected = list(segments)
        except RuntimeError as exc:
            raise AsrError(
                CODE_ASR_DEVICE_BUSY,
                "ASR 推理失败：" + str(exc),
                user_hint="本机语音识别暂时不可用，先用文字聊吧。",
                context={"model": self._settings.model},
            ) from exc
        detected = getattr(info, "language", None)
        detected_language = detected if isinstance(detected, str) else None
        parts = [segment.text.strip() for segment in collected]
        joiner = "" if (detected_language or "").startswith("zh") else " "
        text = normalize_transcript(joiner.join(part for part in parts if part))
        weights: list[float] = []
        probs: list[float] = []
        for segment in collected:
            weights.append(max(segment.end - segment.start, 0.0) or 1.0)
            probs.append(math.exp(min(max(segment.avg_logprob, MIN_AVG_LOGPROB), 0.0)))
        weighted = (
            sum(w * p for w, p in zip(weights, probs, strict=True)) / sum(weights) if probs else 0.0
        )
        confidence = min(max(weighted, 0.0), 1.0)
        segment_end = max((segment.end for segment in collected), default=0.0)
        raw_duration = getattr(info, "duration", 0.0)
        duration_s = segment_end if segment_end > 0 else 0.0
        if not duration_s and isinstance(raw_duration, (int, float)):
            duration_s = float(raw_duration)
        log_event(
            LOGGER,
            logging.INFO,
            module="adapters.asr_faster_whisper",
            event="asr.transcribed",
            message="识别完成",
            fields={
                "model": self._settings.model,
                "request_sample_rate": sample_rate,
                "detected_language": detected_language,
                "duration_s": round(duration_s, 3),
                "chars": len(text),
                "confidence": round(confidence, 3),
            },
        )
        return Transcript(
            text=text,
            confidence=confidence,
            duration_s=duration_s,
            language=detected_language,
        )
