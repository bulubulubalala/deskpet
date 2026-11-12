"""文件职责：sherpa-onnx 本地流式识别适配器（P2）——中文 zipformer，边说边出 partial。

依赖方向：adapters -> core / contracts；不 import services / api。
谁调用：services/asr_service.py 的 build_asr_service 在模型存在时注入；批处理仍由
faster-whisper / 云端负责（本模块只负责 stream()）。

为什么选它：真正的流式（每 100–200ms 就能出 partial）、CPU int8、模型几十 MB、离线。
这里**不自动下载模型**（D14 的精神：本项目只调用，不替用户装东西）——模型缺失时
start_stream 会抛 DP-ASR-004，AsrService 捕获后降级回批处理，语音不会因此变哑。
模型下载脚本：scripts/fetch_asr_stream_model.py。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from config import AsrSettings
from contracts.errors import CODE_ASR_UNAVAILABLE
from core.asr import Transcript, normalize_transcript
from core.errors import AsrError
from core.logging import get_logger

LOGGER = get_logger("sidecar.adapters.asr_stream_sherpa")

#: 收尾时补的静音（秒）：让最后一个字的尾音进模型，避免 final 少字。
TAIL_SILENCE_S = 0.3
#: 16-bit PCM 满量程。
INT16_SCALE = 32768.0

USER_HINT_MODEL_MISSING = (
    "流式识别模型没就位：把 sherpa-onnx 模型放到 data/models/asr-stream/，"
    "或运行 scripts/fetch_asr_stream_model.py；也可以设 DESKPET_ASR_STREAMING=false 用批处理。"
)


@dataclass(frozen=True, slots=True)
class _ModelFiles:
    """sherpa-onnx 需要的四个文件（模型目录里同时可能有 fp32 与 int8，优先 int8）。"""

    tokens: Path
    encoder: Path
    decoder: Path
    joiner: Path


def _pick(model_dir: Path, prefix: str) -> Path:
    """按 `prefix-*.int8.onnx` → `prefix-*.onnx` 的顺序挑一个文件。"""
    for suffix in (".int8.onnx", ".onnx"):
        matches = sorted(model_dir.glob(prefix + "*" + suffix))
        if matches:
            return matches[0]
    raise FileNotFoundError(str(model_dir / (prefix + "*.onnx")))


def find_model_files(model_dir: Path) -> _ModelFiles:
    """定位模型文件；缺任何一个都抛 FileNotFoundError（调用方翻成 DP-ASR-004）。"""
    tokens = model_dir / "tokens.txt"
    if not tokens.is_file():
        raise FileNotFoundError(str(tokens))
    return _ModelFiles(
        tokens=tokens,
        encoder=_pick(model_dir, "encoder"),
        decoder=_pick(model_dir, "decoder"),
        joiner=_pick(model_dir, "joiner"),
    )


class _SherpaStream:
    """一条语音的在线识别流：accept() 喂块，finish() 出终稿。"""

    def __init__(self, recognizer: Any, sample_rate: int) -> None:
        self._recognizer = recognizer
        self._sample_rate = sample_rate
        self._stream = recognizer.create_stream()
        self._samples = 0
        self._partial = ""

    @property
    def partial(self) -> str:
        return self._partial

    def accept(self, pcm: bytes) -> str:
        """喂一块 16-bit 小端单声道 PCM，返回当前 partial。"""
        if not pcm:
            return self._partial
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / INT16_SCALE
        self._samples += int(samples.size)
        self._stream.accept_waveform(self._sample_rate, samples)
        self._decode()
        self._partial = normalize_transcript(self._recognizer.get_result(self._stream))
        return self._partial

    def finish(self) -> Transcript:
        """补一点静音后收尾；返回终稿与时长。"""
        pad = np.zeros(int(self._sample_rate * TAIL_SILENCE_S), dtype=np.float32)
        self._stream.accept_waveform(self._sample_rate, pad)
        self._stream.input_finished()
        self._decode()
        text = normalize_transcript(self._recognizer.get_result(self._stream))
        duration_s = self._samples / self._sample_rate if self._sample_rate > 0 else 0.0
        return Transcript(
            text=text,
            confidence=1.0 if text else 0.0,
            duration_s=duration_s,
            language=None,
        )

    def close(self) -> None:
        """sherpa 的 OnlineStream 由 Python 对象持有，丢引用即可释放。"""
        self._partial = ""

    def _decode(self) -> None:
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)


class SherpaStreamingAsr:
    """懒加载 sherpa-onnx 的 OnlineRecognizer；一次构造、多轮流复用。"""

    def __init__(
        self,
        settings: AsrSettings,
        *,
        recognizer_factory: Any | None = None,
    ) -> None:
        self._settings = settings
        self._recognizer_factory = recognizer_factory or _build_recognizer
        self._recognizer: Any | None = None

    @property
    def is_loaded(self) -> bool:
        return self._recognizer is not None

    def load(self) -> None:
        """构造识别器；模型缺失 / 依赖缺失都翻成 DP-ASR-004（不静默失败）。"""
        if self._recognizer is not None:
            return
        try:
            self._recognizer = self._recognizer_factory(self._settings)
        except ImportError as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "sherpa-onnx 未安装：" + str(exc),
                user_hint="流式识别组件缺失（sherpa-onnx 未安装），会自动退回批处理。",
            ) from exc
        except (OSError, ValueError, RuntimeError) as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "加载流式识别模型失败：" + str(exc),
                user_hint=USER_HINT_MODEL_MISSING,
                context={"model_dir": str(self._settings.stream_model_dir)},
            ) from exc

    def unload(self) -> None:
        self._recognizer = None

    def start_stream(self, *, sample_rate: int, lang: str | None = None) -> _SherpaStream:
        """开一条新的识别流；lang 目前不参与（zipformer 中文模型自带语言）。"""
        del lang
        self.load()
        assert self._recognizer is not None
        return _SherpaStream(self._recognizer, sample_rate)

    def transcribe(self, pcm: bytes, *, sample_rate: int, lang: str | None = None) -> Transcript:
        """整段识别（给 /asr 兜底用）：内部仍走一条流，行为与流式一致。"""
        stream = self.start_stream(sample_rate=sample_rate, lang=lang)
        stream.accept(pcm)
        return stream.finish()


def _build_recognizer(settings: AsrSettings) -> Any:
    """真正 import sherpa_onnx 并构造 OnlineRecognizer（唯一碰它的地方）。"""
    import sherpa_onnx

    files = find_model_files(settings.stream_model_dir)
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(files.tokens),
        encoder=str(files.encoder),
        decoder=str(files.decoder),
        joiner=str(files.joiner),
        num_threads=settings.stream_threads,
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        provider="cpu",
    )


__all__ = [
    "USER_HINT_MODEL_MISSING",
    "SherpaStreamingAsr",
    "find_model_files",
]
