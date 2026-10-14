"""文件职责：时间来源的 Protocol（core 定义接口、adapters 实现，CODE_STYLE §1.1 / §1.4）。

依赖方向：core 只依赖标准库；真实实现见 adapters/system_clock.py。
谁调用：services/health_service.py 用它算 uptime；测试注入假时钟就不必 sleep。
"""

from typing import Protocol


class Clock(Protocol):
    """取时间的抽象：单调秒数算时长，避免受系统改时间影响。"""

    def monotonic(self) -> float:
        """返回单调递增的秒数（uptime 与超时都用它）。"""
        ...
