"""core 层出口。

纯逻辑层：协议定义（Protocol）、状态机、数据结构、异常与日志纯逻辑；
禁止 import adapters 或 api。
"""

from core.clock import Clock
from core.errors import (
    AsrError,
    DeskpetError,
    DeviceError,
    LlmError,
    MemoryStoreError,
    PackError,
    ScreenError,
    SidecarError,
    StageError,
    TtsError,
)
from core.logging import format_trace, get_logger, log_event, redact_fields
from core.module_state import ModuleRegistry
from core.voice_state import VoiceActivity, VoiceSnapshot, VoiceState, VoiceStateMachine

__all__ = [
    "AsrError",
    "Clock",
    "DeskpetError",
    "DeviceError",
    "LlmError",
    "MemoryStoreError",
    "ModuleRegistry",
    "PackError",
    "ScreenError",
    "SidecarError",
    "StageError",
    "TtsError",
    "VoiceActivity",
    "VoiceSnapshot",
    "VoiceState",
    "VoiceStateMachine",
    "format_trace",
    "get_logger",
    "log_event",
    "redact_fields",
]
