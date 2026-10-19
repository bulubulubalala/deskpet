"""文件职责：语音合成的领域对象与取消语义常量（不依赖 HTTP、不依赖引擎）。

依赖方向：core -> （无业务模块）；被 adapters / services 同时使用。
为什么放在 core：适配器与用例层都要谈「合成结果」和「取消结果」，
按 CODE_STYLE §1.1，两边都只能向下依赖 core，不能互相 import。
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "CANCEL_IN_FLIGHT",
    "CANCEL_QUEUED",
    "CANCEL_STATES",
    "CANCEL_UNKNOWN",
    "TtsAudio",
    "TtsHealth",
    "cancel_is_effective",
]

#: 适配器 /cancel 的三种返回值（需求 §6.12「取消语义」）
CANCEL_QUEUED = "queued"
CANCEL_IN_FLIGHT = "in_flight"
CANCEL_UNKNOWN = "unknown"
CANCEL_STATES: tuple[str, ...] = (CANCEL_QUEUED, CANCEL_IN_FLIGHT, CANCEL_UNKNOWN)


def cancel_is_effective(state: str) -> bool:
    """queued / in_flight 都算「取消已被受理」，unknown 表示这句已经结束了。"""
    return state in (CANCEL_QUEUED, CANCEL_IN_FLIGHT)


@dataclass(frozen=True, slots=True)
class TtsAudio:
    """一次合成的产物：音频字节 + 引擎侧性能数字（响应头 X-Deskpet-* 原样带出）。

    gen_ms / audio_ms / rtf 是 T1.7「首音 <0.5s」与 MEASURED.md 的取数来源，
    因此必须从适配器一路透传到调用方，不能在这里丢掉。
    """

    audio: bytes
    request_id: str
    gen_ms: int
    audio_ms: int
    rtf: float
    voice: str
    #: 音频容器格式：IndexTTS 适配器给 "wav"，edge-tts 给 "mp3"（§6.3 的 /tts 媒体类型随它变）。
    format: str = "wav"

    @property
    def duration_s(self) -> float:
        """音频时长（秒），由适配器给的毫秒数换算。"""
        return self.audio_ms / 1000.0


@dataclass(frozen=True, slots=True)
class TtsHealth:
    """适配器 /health 的快照（需求 §6.12）——只读、不触发模型加载。

    F9 的 engine.not_loaded 事件与 T1.8 的资源闸门都看它。
    """

    ready: bool
    model_loaded: bool
    load_ms: int
    sample_rate: int
    queue_pending: int
    queue_current: str | None
