r"""文件职责：IndexTTS 模型的生命周期（懒加载 / 卸载）与单句推理。

依赖方向：被 worker 调用；自己依赖 audio（归一化）与 errors（错误类型）。
**不 import deskpet 的任何模块**，也不安装 / 修复 / 升级 IndexTTS（需求 D14）。
串行保证：推理全程持有 self._lock（IndexTTS 不是线程安全的），加上 worker 只有一条线程，
所以「同一时刻只有一个 infer 在跑」是双保险。
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Protocol

from tools.indextts_adapter.audio import peak_normalize, read_wav, write_wav
from tools.indextts_adapter.errors import AdapterError

__all__ = ["IndexTtsEngine", "SynthEngine", "SynthRequestLike"]

LOG = logging.getLogger("deskpet.indextts_adapter.engine")


class SynthRequestLike(Protocol):
    """worker 交给引擎的最小请求形状（放这里是为了让 engine 不依赖 worker）。"""

    request_id: str
    text: str
    voice: str
    lang: str
    emo_vector: list[float] | None
    target_peak: float


class SynthEngine(Protocol):
    """worker 眼里的引擎接口。测试用 FakeEngine 实现它，不必装 torch（CODE_STYLE §1.4）。"""

    # loaded 声明成只读属性：真实引擎用 @property 实现，FakeEngine 用普通属性也满足它
    @property
    def loaded(self) -> bool: ...

    load_ms: int | None
    sample_rate: int

    def load(self) -> None: ...

    def unload(self) -> None: ...

    def synth(self, req: SynthRequestLike) -> tuple[bytes, dict[str, Any]]: ...


class IndexTtsEngine:
    """真实引擎：把 IndexTTS2 包成「加载 / 卸载 / 合成一句」三件事。"""

    def __init__(self, model_dir: Path, voice_dir: Path) -> None:
        self.model_dir = model_dir
        self.voice_dir = voice_dir
        self.load_ms: int | None = None
        self.sample_rate: int = 0
        self._model: Any = None
        self._lock = threading.RLock()
        self._last_used_at = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def resolve_voice(self, voice: str) -> Path:
        """把调用方给的声音名解析成参考音 wav 的绝对路径；找不到就是 DP-TTS-400。

        不做任何「猜一个相近的音色」的兜底——换音色是用户能感知的事，必须显式失败（需求 §6.12）。
        """
        candidate = Path(voice)
        if not candidate.is_absolute():
            candidate = self.voice_dir / voice
            if candidate.suffix.lower() != ".wav":
                candidate = candidate.with_suffix(".wav")
        if not candidate.is_file():
            raise AdapterError(
                "DP-TTS-400",
                f"参考音不存在：{candidate}",
                "检查角色包 voice.json 里的参考音，或把 wav 放进 IndexTTS 的 voices 目录",
            )
        return candidate

    def load(self) -> None:
        """按需加载。第一次会阻塞十几秒到上百秒，期间 /health 的 ready 为 false（需求 §6.12）。"""
        with self._lock:
            if self._model is not None:
                return
            # 延迟 import：不合成就不用把 torch 拉起来，方便先看 /health
            from indextts.infer_v2_5 import IndexTTS2

            cfg_path = self.model_dir / "config.yaml"
            if not cfg_path.is_file():
                raise AdapterError(
                    "DP-TTS-503",
                    f"找不到模型配置：{cfg_path}",
                    "确认 IndexTTS 的 checkpoints 目录完整",
                )
            started = time.perf_counter()
            # use_qwen_emo=False：情感由 LLM 给 8 维向量，不用 QwenEmotion（需求 D3）
            self._model = IndexTTS2(
                cfg_path=str(cfg_path),
                model_dir=str(self.model_dir),
                use_bf16=True,
                use_cuda_kernel=False,
                use_torch_compile=False,
                use_qwen_emo=False,
            )
            self.load_ms = int((time.perf_counter() - started) * 1000)
            self._last_used_at = time.time()
            LOG.info("model loaded in %.1fs", self.load_ms / 1000)

    def unload(self) -> None:
        """卸载**我们自己加载的**模型实例并尽量归还显存（需求 §4.4 资源闸门 / OOM 降级）。

        注意边界：这只卸我们进程内的实例，不是替用户重启引擎（D14）。
        """
        with self._lock:
            if self._model is None:
                return
            self._model = None
            try:
                import torch  # type: ignore[import-not-found]

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # pragma: no cover - 卸载失败不影响正确性
                LOG.warning("empty_cache failed: %s", traceback.format_exc(limit=1))
            LOG.info("model unloaded")

    def synth(self, req: SynthRequestLike) -> tuple[bytes, dict[str, Any]]:
        """合成一句话，返回 (wav 字节, 统计)。推理持锁串行，因此调用方不必自己排队。

        临时 wav 写在模型目录旁边（IndexTTS 要求 output_path），读完立即删，不留垃圾。
        """
        voice_path = self.resolve_voice(req.voice)
        with self._lock:
            self.load()
            started = time.perf_counter()
            out_dir = self.model_dir.parent / "_deskpet_tts_tmp"
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{req.request_id}.wav"
            kwargs: dict[str, Any] = {}
            if req.emo_vector is not None:
                kwargs["emo_vector"] = req.emo_vector
            try:
                self._model.infer(
                    spk_audio_prompt=str(voice_path),
                    text=req.text,
                    lang=req.lang,
                    output_path=str(out_path),
                    verbose=False,
                    **kwargs,
                )
                raw = out_path.read_bytes()
            finally:
                out_path.unlink(missing_ok=True)
            gen_ms = int((time.perf_counter() - started) * 1000)
            self._last_used_at = time.time()
        audio, sample_rate = read_wav(raw)
        duration_s = len(audio) / sample_rate if sample_rate else 0.0
        if req.target_peak > 0 and duration_s > 0:
            audio = peak_normalize(audio, req.target_peak)
            raw = write_wav(audio, sample_rate)
        self.sample_rate = sample_rate
        meta = {
            "sample_rate": sample_rate,
            "audio_ms": int(duration_s * 1000),
            "gen_ms": gen_ms,
            "rtf": round(gen_ms / 1000 / duration_s, 3) if duration_s > 0 else 0.0,
            "voice": str(voice_path),
            "model_load_ms": self.load_ms,
        }
        return raw, meta
