r"""文件职责：wav 的读取、峰值归一化与写回（soundfile + numpy）。

依赖方向：只被 engine 导入。
为什么在函数里延迟 import：soundfile / numpy 是 IndexTTS 自己带的依赖，本适配器不额外要求安装，
也不负责安装它们（需求 D14：引擎由用户维护）；延迟 import 让「只看 /health」不需要拉起这些东西。
mypy 侧对这几个模块配了 ignore_missing_imports，故这里不必写 type: ignore。
"""

from __future__ import annotations

import io
from typing import Any

__all__ = ["peak_normalize", "read_wav", "write_wav"]


def read_wav(raw: bytes) -> tuple[Any, int]:
    """读出波形与采样率，供归一化使用。多声道会降成单声道。"""
    import numpy as np
    import soundfile as sf

    data, sample_rate = sf.read(io.BytesIO(raw), dtype="float32")
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    return np.asarray(data, dtype="float32"), int(sample_rate)


def peak_normalize(audio: Any, target_peak: float) -> Any:
    """把峰值拉到 target_peak。峰值本来就是 0（全静音）时原样返回，避免除零。"""
    import numpy as np

    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        return audio
    return (audio / peak * target_peak).astype("float32")


def write_wav(audio: Any, sample_rate: int) -> bytes:
    """写成 PCM_16 的 wav 字节（前端 <audio> 与 Electron 都能直接放）。"""
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
