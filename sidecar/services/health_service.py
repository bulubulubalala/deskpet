"""文件职责：/health 的用例编排（把 core 的状态表与注入的时钟/显存探针拼成响应）。

依赖方向：services -> core + contracts；不 import api / adapters（实例由组合根注入）。
谁调用：api/health.py 的路由（HTTP 边界）。
"""

from collections.abc import Callable

from contracts.health import GpuUsage, HealthResponse, HealthStatus, ModuleState, VoiceStateName
from contracts.routes import SERVICE_VERSION
from core.clock import Clock
from core.module_state import ModuleRegistry

GpuUsageProvider = Callable[[], GpuUsage]
VoiceStateProvider = Callable[[], VoiceStateName]


def _idle_voice_state() -> VoiceStateName:
    """没注入语音服务时的兜底（只跑 /health 的用例不必造状态机）。"""
    return "idle"


# 判定「一切正常」的状态集合：idle / loading / ready 都算健康，只有 error / offline 才降级
_HEALTHY_STATES = frozenset({ModuleState.IDLE, ModuleState.LOADING, ModuleState.READY})


class HealthService:
    """心跳服务：纯只读聚合，绝不加载模型、不抢 GPU 锁（需求 §6.3）。"""

    def __init__(
        self,
        registry: ModuleRegistry,
        clock: Clock,
        gpu_usage_provider: GpuUsageProvider,
        voice_state_provider: VoiceStateProvider | None = None,
    ) -> None:
        self._registry = registry
        self._clock = clock
        self._gpu_usage_provider = gpu_usage_provider
        self._voice_state_provider = voice_state_provider or _idle_voice_state
        self._started_at = clock.monotonic()

    def snapshot(self) -> HealthResponse:
        """组装响应：任一模块 error / offline 时 status=degraded，其余 ok。

        voice 由注入的取值函数给出（组合根传 VoiceService.state），保证与路由登记的活动
        是同一份数据。
        """
        modules = self._registry.snapshot()
        is_healthy = all(module.state in _HEALTHY_STATES for module in modules)
        status: HealthStatus = "ok" if is_healthy else "degraded"
        return HealthResponse(
            status=status,
            uptime_s=round(self._clock.monotonic() - self._started_at, 3),
            modules=modules,
            gpu=self._gpu_usage_provider(),
            voice=self._voice_state_provider(),
            version=SERVICE_VERSION,
        )
