"""文件职责：sidecar 的组合根（构造依赖并注入，CODE_STYLE §1.4）。

依赖方向：本模块是唯一可以同时 import api / services / core / adapters 的地方（CODE_STYLE §1.1）。
谁调用：开发态用 uvicorn app:create_app --factory；T0.5 起由 launcher 拉起并写 runtime.json。
"""

from fastapi import FastAPI

from adapters.system_clock import SystemClock
from api.router import build_router
from contracts.health import GpuUsage, ModuleName
from contracts.routes import SERVICE_NAME, SERVICE_VERSION
from core.clock import Clock
from core.module_state import ModuleRegistry
from services.health_service import GpuUsageProvider, HealthService

MODULE_NAMES: tuple[ModuleName, ...] = (
    ModuleName.TTS,
    ModuleName.ASR,
    ModuleName.LLM,
    ModuleName.MEMORY,
    ModuleName.SCREEN,
    ModuleName.STAGE,
)


def _no_gpu_usage() -> GpuUsage:
    """M0 的显存探针：不加载模型、不碰 CUDA，直接报「本进程未占显存」（需求 §6.3）。

    真实探测（pynvml / torch）在 M1 接上；放在函数里是为了让 /health 保持轻量。
    """
    return GpuUsage(loaded_mb=0, total_mb=None)


def build_health_service(
    clock: Clock | None = None,
    gpu_usage_provider: GpuUsageProvider | None = None,
) -> HealthService:
    """构造心跳服务：默认系统时钟 + 不探测显存的探针。"""
    return HealthService(
        registry=ModuleRegistry(MODULE_NAMES),
        clock=clock or SystemClock(),
        gpu_usage_provider=gpu_usage_provider or _no_gpu_usage,
    )


def create_app(health_service: HealthService | None = None) -> FastAPI:
    """构造 FastAPI 应用；传入 health_service 可注入假实现（测试不需要硬件）。"""
    app = FastAPI(title=SERVICE_NAME, version=SERVICE_VERSION)
    app.include_router(build_router(health_service or build_health_service()))
    return app
