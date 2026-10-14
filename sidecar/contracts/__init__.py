"""contracts 层出口。

跨进程契约：sidecar HTTP API、LLM 事件协议、runtime.json 与错误信封的常量与模型
（需求 §6.2 / §6.3 / §6.10）。
"""

from contracts.errors import ErrorEnvelope
from contracts.runtime import RuntimeInfo

__all__ = [
    "ErrorEnvelope",
    "RuntimeInfo",
]
