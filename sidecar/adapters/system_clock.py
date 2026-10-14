"""文件职责：Clock 的真实实现（对 time.monotonic 的薄封装）。

依赖方向：adapters 实现 core 定义的 Protocol；core 不反向 import（CODE_STYLE §1.1）。
谁调用：sidecar/app.py 组合根构造后注入给 services。
"""

import time

from core.clock import Clock


class SystemClock(Clock):
    """系统单调时钟。"""

    def monotonic(self) -> float:
        """返回 time.monotonic()。"""
        return time.monotonic()
