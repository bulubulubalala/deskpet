"""adapters 层出口：外部世界（SQLite、DPAPI、IndexTTS、faster-whisper、云端 LLM、屏幕 OCR）。

依赖方向：adapters -> core（实现 core 定义的 Protocol）；core 不反向 import。
"""

from adapters.system_clock import SystemClock

__all__ = [
    "SystemClock",
]
