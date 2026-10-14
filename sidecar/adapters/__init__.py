"""adapters 层出口：外部世界（SQLite、DPAPI、IndexTTS、faster-whisper、云端 LLM、屏幕 OCR）。

依赖方向：adapters -> core / contracts；core 不反向 import。
"""

from adapters.runtime_file import read_runtime_file, remove_runtime_file, write_runtime_file
from adapters.socket_binding import bind_listening_socket
from adapters.system_clock import SystemClock

__all__ = [
    "SystemClock",
    "bind_listening_socket",
    "read_runtime_file",
    "remove_runtime_file",
    "write_runtime_file",
]
