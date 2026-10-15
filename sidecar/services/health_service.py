"""文件职责：/health 的用例编排（把 core 的状态表与注入的时钟/语音状态拼成响应）。

依赖方向：services -> core + contracts；不 import api / adapters（实例由组合根注入）。
谁调用：api/health.py 的路由（HTTP 边界）。
"""

from collections.abc import Callable, Sequence

from config import PROVIDER_LOCAL, Settings
from contracts.health import (
    HealthResponse,
    HealthStatus,
    ModuleName,
    ModuleState,
    ProviderHealth,
    VoiceStateName,
)
from contracts.routes import SERVICE_VERSION
from core.clock import Clock
from core.module_state import ModuleRegistry

VoiceStateProvider = Callable[[], VoiceStateName]
ProviderProvider = Callable[[], Sequence[ProviderHealth]]
#: 模块态的取值函数：返回「模块名 → 状态 + 机器可读原因」，由组合根按可用性提供
ModuleStateProvider = Callable[[], Sequence[tuple[ModuleName, ModuleState, str | None]]]


def _no_providers() -> tuple[ProviderHealth, ...]:
    """没注入时的兜底：不谎报任何供给（只跑 /health 的用例看不到编造的 provider）。"""
    return ()


def _no_module_states() -> tuple[tuple[ModuleName, ModuleState, str | None], ...]:
    """没注入时的兜底：所有模块保持登记表里的初始态（idle），不编造状态。"""
    return ()


def build_provider_health(settings: Settings) -> tuple[ProviderHealth, ...]:
    """把配置里的三个能力面供给翻成心跳条目（§6.13）。

    只说「选了谁、配没配、用的哪个模型」，**绝不放 api_key**——/health 是心跳，
    会被写进日志与界面。configured=False 表示这个 provider 没配好（或云端尚未实现）。
    """
    selected_model = (
        settings.llm.local_model if settings.llm.provider == PROVIDER_LOCAL else settings.llm.model
    ).strip()
    asr_is_local = settings.asr.provider == PROVIDER_LOCAL
    tts_is_local = settings.tts.provider == PROVIDER_LOCAL
    return (
        ProviderHealth(
            capability="llm",
            name=settings.llm.provider,
            configured=bool(settings.llm.endpoint_specs()),
            detail=selected_model or None,
        ),
        ProviderHealth(
            capability="asr",
            name=settings.asr.provider,
            configured=asr_is_local,
            detail=None if asr_is_local else "云端识别尚未实现（T1.14 后置）",
        ),
        ProviderHealth(
            capability="tts",
            name=settings.tts.provider,
            configured=tts_is_local,
            detail=None if tts_is_local else "云端语音合成尚未实现（T1.14 后置）",
        ),
    )


def _idle_voice_state() -> VoiceStateName:
    """没注入语音服务时的兜底（只跑 /health 的用例不必造状态机）。"""
    return "idle"


# 判定「一切正常」的状态集合：idle / loading / ready 都算健康，只有 error / offline 才降级
_HEALTHY_STATES = frozenset({ModuleState.IDLE, ModuleState.LOADING, ModuleState.READY})


class HealthService:
    """心跳服务：纯只读聚合，绝不加载模型、不碰引擎与显存（需求 §6.3）。"""

    def __init__(
        self,
        registry: ModuleRegistry,
        clock: Clock,
        voice_state_provider: VoiceStateProvider | None = None,
        provider_provider: ProviderProvider | None = None,
        module_state_provider: ModuleStateProvider | None = None,
    ) -> None:
        self._registry = registry
        self._clock = clock
        self._voice_state_provider = voice_state_provider or _idle_voice_state
        self._provider_provider = provider_provider or _no_providers
        self._module_state_provider = module_state_provider or _no_module_states
        self._started_at = clock.monotonic()

    def snapshot(self) -> HealthResponse:
        """组装响应：任一模块 error / offline 时 status=degraded，其余 ok。

        voice 由注入的取值函数给出（组合根传 VoiceService.state），保证与路由登记的活动
        是同一份数据。
        module_state_provider 让组合根把「库/密钥打不开」这类事实翻译成模块态（T2.1a 的
        memory 模块就走这条路），本类只负责聚合，不做任何探测。
        """
        for name, state, detail in self._module_state_provider():
            self._registry.mark(name, state, detail)
        modules = self._registry.snapshot()
        is_healthy = all(module.state in _HEALTHY_STATES for module in modules)
        status: HealthStatus = "ok" if is_healthy else "degraded"
        return HealthResponse(
            status=status,
            uptime_s=round(self._clock.monotonic() - self._started_at, 3),
            modules=modules,
            providers=list(self._provider_provider()),
            voice=self._voice_state_provider(),
            version=SERVICE_VERSION,
        )
