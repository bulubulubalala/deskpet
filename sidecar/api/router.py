"""文件职责：把各路由拼成一个 APIRouter（api 层的组装点，不含业务逻辑）。

依赖方向：api -> services（仅注入），不 import adapters（CODE_STYLE §1.1）。
谁调用：sidecar/app.py（组合根）。
"""

from pathlib import Path

from fastapi import APIRouter

from api.asr import build_asr_router
from api.chat import build_chat_router
from api.health import build_health_router
from api.memory import build_memory_router
from api.presence import build_presence_router
from api.providers import build_providers_router
from api.screen import build_screen_router
from api.stubs import build_stub_router
from api.tts import build_tts_router
from api.usage import build_usage_router
from api.voice_ws import build_voice_ws_router
from services.asr_service import AsrService
from services.chat_service import ChatService
from services.health_service import HealthService
from services.memory_service import MemoryService
from services.ocr_service import OcrService
from services.presence_service import PresenceService
from services.provider_test_service import ProviderTestService
from services.tts_service import TtsService
from services.usage_service import UsageService
from services.vision_service import VisionService
from services.voice_service import VoiceService
from services.voice_session import VoiceSession


def build_router(
    health_service: HealthService,
    chat_service: ChatService,
    asr_service: AsrService,
    tts_service: TtsService,
    voice_service: VoiceService,
    provider_test_service: ProviderTestService,
    memory_service: MemoryService,
    usage_service: UsageService,
    characters_dir: Path,
    vision_service: VisionService,
    presence_service: PresenceService,
    ocr_service: OcrService,
) -> APIRouter:
    """构建 sidecar 全部路由：已实现的挂真处理器，其余按 contracts/routes.py 挂 501 桩。"""
    router = APIRouter()
    router.include_router(build_health_router(health_service))
    router.include_router(build_chat_router(chat_service, voice_service))
    router.include_router(build_asr_router(asr_service, voice_service))
    router.include_router(build_tts_router(tts_service, voice_service))
    router.include_router(build_providers_router(provider_test_service))
    router.include_router(build_memory_router(memory_service, usage_service))
    router.include_router(build_usage_router(usage_service))
    router.include_router(build_presence_router(presence_service))
    router.include_router(build_screen_router(vision_service, ocr_service, 8_000_000))
    # P2：语音全双工长连接；每条连接一个 VoiceSession（有自己的 generation 与音频缓冲）
    router.include_router(
        build_voice_ws_router(
            lambda: VoiceSession(
                asr=asr_service,
                chat=chat_service,
                tts=tts_service,
                voice=voice_service,
                characters_dir=characters_dir,
            )
        )
    )
    router.include_router(build_stub_router())
    return router
