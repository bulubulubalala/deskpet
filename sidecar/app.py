"""文件职责：sidecar 的组合根（构造依赖并注入，CODE_STYLE §1.4）。

依赖方向：本模块是唯一可以同时 import api / services / core / adapters 的地方（CODE_STYLE §1.1）。
谁调用：开发态用 uvicorn app:create_app --factory；T0.5 起由 main.py（launcher）拉起。
"""

from fastapi import FastAPI

from adapters.system_clock import SystemClock
from api.auth import TokenAuthMiddleware
from api.error_handlers import register_error_handlers
from api.router import build_router
from config import Settings, load_settings
from contracts.health import GpuUsage, ModuleName
from contracts.routes import SERVICE_NAME, SERVICE_VERSION
from core.clock import Clock
from core.module_state import ModuleRegistry
from services.asr_service import AsrService, build_asr_service
from services.chat_service import ChatService, build_chat_service
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


def create_app(
    health_service: HealthService | None = None,
    chat_service: ChatService | None = None,
    asr_service: AsrService | None = None,
    token: str | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    """构造 FastAPI 应用。

    - health_service / chat_service / asr_service：注入真实或假实现；测试不需要任何硬件与网络
      （ASR 只在第一次请求时才加载模型，注入假实现即可完全离线测试）。
    - settings：进程设置；不传就现读一次环境变量（测试与 /docs 调试方便）。
    - token：传入则启用回环 token 校验（需求 §6.10）；None = 不校验，供单测与本地 /docs 调试。
      正式启动路径永远是 main.py，它必定生成 token。
    - 统一异常处理器：core 的 DeskpetError → 500 失败信封 + 一条带 code / trace 的日志
      （api/error_handlers.py）。
    """
    resolved = settings or load_settings()
    app = FastAPI(title=SERVICE_NAME, version=SERVICE_VERSION)
    register_error_handlers(app)
    if token is not None:
        app.add_middleware(TokenAuthMiddleware, token=token)
    app.include_router(
        build_router(
            health_service or build_health_service(),
            chat_service or build_chat_service(resolved),
            asr_service or build_asr_service(resolved),
        )
    )
    return app
