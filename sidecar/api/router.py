"""文件职责：把各路由拼成一个 APIRouter（api 层的组装点，不含业务逻辑）。

依赖方向：api -> services（仅注入），不 import adapters（CODE_STYLE §1.1）。
谁调用：sidecar/app.py（组合根）。
"""

from fastapi import APIRouter

from api.asr import build_asr_router
from api.chat import build_chat_router
from api.health import build_health_router
from api.memory import build_memory_router
from api.providers import build_providers_router
from api.stubs import build_stub_router
from api.tts import build_tts_router
from api.usage import build_usage_router
from services.asr_service import AsrService
from services.chat_service import ChatService
from services.health_service import HealthService
from services.memory_service import MemoryService
from services.provider_test_service import ProviderTestService
from services.tts_service import TtsService
from services.usage_service import UsageService
from services.voice_service import VoiceService


def build_router(
    health_service: HealthService,
    chat_service: ChatService,
    asr_service: AsrService,
    tts_service: TtsService,
    voice_service: VoiceService,
    provider_test_service: ProviderTestService,
    memory_service: MemoryService,
    usage_service: UsageService,
) -> APIRouter:
    """构建 sidecar 全部路由：已实现的挂真处理器，其余按 contracts/routes.py 挂 501 桩。"""
    router = APIRouter()
    router.include_router(build_health_router(health_service))
    router.include_router(build_chat_router(chat_service, voice_service))
    router.include_router(build_asr_router(asr_service, voice_service))
    router.include_router(build_tts_router(tts_service, voice_service))
    router.include_router(build_providers_router(provider_test_service))
    router.include_router(build_memory_router(memory_service))
    router.include_router(build_usage_router(usage_service))
    router.include_router(build_stub_router())
    return router
