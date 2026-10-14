"""core 层出口。

纯逻辑层：协议定义（Protocol）、状态机、数据结构；禁止 import adapters 或 api。
"""

from core.clock import Clock
from core.module_state import ModuleRegistry

__all__ = [
    "Clock",
    "ModuleRegistry",
]
