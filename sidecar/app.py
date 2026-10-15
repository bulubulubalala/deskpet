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
from contracts.health import ModuleName
from contracts.routes import SERVICE_NAME, SERVICE_VERSION
from core.clock import Clock
from core.env_events import EnvEventBus
from core.module_state import ModuleRegistry
from services.asr_service import AsrService, build_asr_service
from services.chat_service import ChatService, build_chat_service
from services.health_service import HealthService, VoiceStateProvider, build_provider_health
from services.tts_service import TtsService, build_tts_service
from services.usage_service import UsageService, build_usage_service
from services.voice_service import VoiceService, build_voice_service

MODULE_NAMES: tuple[ModuleName, ...] = (
    ModuleName.TTS,
    ModuleName.ASR,
    ModuleName.LLM,
    ModuleName.MEMORY,
    ModuleName.SCREEN,
    ModuleName.STAGE,
)


def build_health_service(
    clock: Clock | None = None,
    voice_state_provider: VoiceStateProvider | None = None,
    settings: Settings | None = None,
) -> HealthService:
    """构造心跳服务：默认系统时钟 + 可选的语音状态取值函数与供给信息（§6.13）。"""
    return HealthService(
        registry=ModuleRegistry(MODULE_NAMES),
        clock=clock or SystemClock(),
        voice_state_provider=voice_state_provider,
        provider_provider=(lambda: build_provider_health(settings)) if settings else None,
    )


def create_app(
    health_service: HealthService | None = None,
    chat_service: ChatService | None = None,
    asr_service: AsrService | None = None,
    tts_service: TtsService | None = None,
    token: str | None = None,
    settings: Settings | None = None,
    voice_service: VoiceService | None = None,
    usage_service: UsageService | None = None,
    env_events: EnvEventBus | None = None,
) -> FastAPI:
    """构造 FastAPI 应用。

    - health_service / chat_service / asr_service / tts_service：注入真实或假实现；测试不需要
      任何硬件与网络（ASR 只在第一次请求时才加载模型，TTS 由用户自己部署的适配器提供，
      注入假实现即可完全离线测试）。
    - settings：进程设置；不传就现读一次环境变量（测试与 /docs 调试方便）。
    - voice_service：语音状态机（T1.6）。默认新建一份，并把它的 state 取值函数交给 /health，
      保证「sidecar 视角的语音状态」与路由里登记的活动是同一份数据。
    - usage_service：使用统计（T1.9）。默认新建一份并注入 ChatService；它只在内存里累积，
      攒够一个批量窗口才写 usage.db，写失败只记日志（§6.7 A 级）。
    - env_events：环境事件总线（T1.10，§6.8）。默认新建一份并注入 Chat / ASR / TTS；
      各模块只上报事实，表现层（F9）在 M4 消费它的 active() 视图。
    - token：传入则启用回环 token 校验（需求 §6.10）；None = 不校验，供单测与本地 /docs 调试。
      正式启动路径永远是 main.py，它必定生成 token。
    - 统一异常处理器：core 的 DeskpetError → 500 失败信封 + 一条带 code / trace 的日志
      （api/error_handlers.py）。
    """
    resolved = settings or load_settings()
    resolved_voice = voice_service or build_voice_service()
    resolved_usage = usage_service or build_usage_service(resolved)
    resolved_env = env_events or EnvEventBus()
    app = FastAPI(title=SERVICE_NAME, version=SERVICE_VERSION)
    register_error_handlers(app)
    if token is not None:
        app.add_middleware(TokenAuthMiddleware, token=token)
    app.include_router(
        build_router(
            health_service
            or build_health_service(
                voice_state_provider=resolved_voice.state,
                settings=resolved,
            ),
            chat_service or build_chat_service(resolved, usage=resolved_usage, env=resolved_env),
            asr_service or build_asr_service(resolved, env=resolved_env),
            tts_service or build_tts_service(resolved, env=resolved_env),
            resolved_voice,
        )
    )
    # 供优雅退出时收尾（把开着的会话写完）；挂 state 而不是改返回值，避免破坏既有调用方
    app.state.usage_service = resolved_usage
    # 供 M4 的表现层与调试读取事件；M1 只保证「有人往这里登记事实」
    app.state.env_events = resolved_env
    return app
