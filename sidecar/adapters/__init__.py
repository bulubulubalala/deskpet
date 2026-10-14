"""adapters 层出口：外部世界（日志文件、SQLite、DPAPI、TTS、ASR、云端 LLM、屏幕 OCR）。

依赖方向：adapters -> core / contracts；core 不反向 import。
"""

from adapters.log_writer import (
    JsonLineFormatter,
    RollingJsonLogHandler,
    resolve_level,
    setup_logging,
)
from adapters.runtime_file import read_runtime_file, remove_runtime_file, write_runtime_file
from adapters.socket_binding import bind_listening_socket
from adapters.system_clock import SystemClock

__all__ = [
    "JsonLineFormatter",
    "RollingJsonLogHandler",
    "SystemClock",
    "bind_listening_socket",
    "read_runtime_file",
    "remove_runtime_file",
    "resolve_level",
    "setup_logging",
    "write_runtime_file",
]
