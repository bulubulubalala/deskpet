"""contracts 层出口。

跨进程契约：sidecar HTTP API、LLM 事件协议、错误码与信封、runtime.json
（需求 §6.2 / §6.3 / §6.10）。
"""

from contracts.errors import ERROR_CODES, ErrorDomain, ErrorEnvelope, domain_of
from contracts.runtime import RuntimeInfo

__all__ = [
    "ERROR_CODES",
    "ErrorDomain",
    "ErrorEnvelope",
    "RuntimeInfo",
    "domain_of",
]
