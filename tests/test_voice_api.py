"""文件职责：语音状态机与 HTTP 边界的联动测试（/health 的 voice 字段、路由登记的活动）。

依赖方向：tests -> app（组合根）+ services（真实用例层）+ FastAPI TestClient + 假适配器。
谁调用：pytest。

覆盖重点：/health 暴露同一份状态机；/asr、/tts 无论成功还是失败都注销活动（不卡死）；
空闲时 /tts/cancel 是空操作。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import create_app
from contracts.errors import CODE_TTS_NOT_AVAILABLE
from core.asr import Transcript
from core.errors import TtsError
from core.tts import TtsAudio
from services.asr_service import AsrService
from services.tts_service import TtsService
from services.voice_service import build_voice_service

PCM_MEDIA_TYPE = "application/octet-stream"
PCM = b"\x00\x00" * 1600


class FakeAsr:
    """假 ASR：要么正常返回，要么睡过头（触发超时路径）。"""

    def __init__(self, *, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s

    @property
    def is_loaded(self) -> bool:
        return True

    def load(self) -> None:
        """无需加载。"""

    def unload(self) -> None:
        """无需卸载。"""

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        import asyncio

        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return Transcript(text="你好", confidence=0.9, duration_s=1.0, language="zh")


class FakeTts:
    """假 TTS：可控制成功 / 失败，便于覆盖两条出口路径。"""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    async def synthesize(self, request: object) -> TtsAudio:
        if self.fail:
            raise TtsError(CODE_TTS_NOT_AVAILABLE, "引擎没在跑", user_hint="请自行启动 IndexTTS")
        return TtsAudio(
            audio=b"RIFFfake",
            request_id="r1",
            gen_ms=10,
            audio_ms=100,
            rtf=0.1,
            voice="amber",
        )

    async def cancel(self, request_id: str) -> str:
        return "unknown"


def _client(
    *,
    asr: FakeAsr | None = None,
    asr_timeout_s: float = 15.0,
    tts: FakeTts | None = None,
    voice: object = None,
) -> TestClient:
    return TestClient(
        create_app(
            asr_service=AsrService(asr or FakeAsr(), timeout_s=asr_timeout_s),
            tts_service=TtsService(tts or FakeTts(), timeout_s=30.0),
            voice_service=voice,
        )
    )


def test_health_reports_idle_voice_state_by_default() -> None:
    body = _client().get("/health").json()

    assert body["voice"] == "idle"


def test_health_reflects_injected_voice_service() -> None:
    voice = build_voice_service()
    client = _client(voice=voice)

    voice.listen_start()
    assert client.get("/health").json()["voice"] == "listening"

    voice.listen_stop()
    assert client.get("/health").json()["voice"] == "idle"


def test_asr_success_releases_activity() -> None:
    client = _client()

    response = client.post("/asr?request_id=r1", content=PCM, headers={"Content-Type": PCM_MEDIA_TYPE})

    assert response.status_code == 200
    assert client.get("/health").json()["voice"] == "idle"


def test_asr_timeout_still_releases_activity() -> None:
    client = _client(asr=FakeAsr(delay_s=0.2), asr_timeout_s=0.01)

    response = client.post("/asr?request_id=r1", content=PCM, headers={"Content-Type": PCM_MEDIA_TYPE})

    assert response.status_code == 500
    assert client.get("/health").json()["voice"] == "idle"


def test_tts_failure_still_releases_activity() -> None:
    client = _client(tts=FakeTts(fail=True))

    response = client.post("/tts", json={"text": "你好", "voice_id": "amber", "request_id": "r1"})

    assert response.status_code == 500
    assert response.json()["code"] == CODE_TTS_NOT_AVAILABLE
    assert client.get("/health").json()["voice"] == "idle"


def test_tts_cancel_while_idle_is_noop() -> None:
    client = _client()

    response = client.post("/tts/cancel", json={"request_id": "r1"})

    assert response.status_code == 200
    assert response.json()["cancelled"] is False
    assert client.get("/health").json()["voice"] == "idle"
