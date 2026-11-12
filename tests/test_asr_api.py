"""文件职责：POST /asr 的 HTTP 契约测试（真实 service + 假适配器；不加载真模型）。

依赖方向：tests -> app（组合根）+ services（真实用例层）+ FastAPI TestClient + 假适配器。
谁调用：pytest。

关键约定（需求 §6.7）：空音频与幻听都不是错误——一律 200 + text=""，
由上层状态机（T1.6）转成「没听清，再说一次」；只有超时与录音本身不合法才失败。
"""

from __future__ import annotations

import asyncio
import time

from fastapi.testclient import TestClient

from app import create_app
from contracts.errors import (
    CODE_ASR_BAD_AUDIO,
    CODE_ASR_TIMEOUT,
    CODE_UNAUTHORIZED,
)
from core.asr import Transcript
from services.asr_service import AsrService

TOKEN = "test-token"
PCM_MEDIA_TYPE = "application/octet-stream"
PCM = b"\x00\x00" * 16000  # 16kHz 单声道 int16 的 1 秒静音
MAX_ASR_BODY_BYTES = 4 * 1024 * 1024


class FakeAdapter:
    """假适配器：不加载模型，回放固定识别结果。"""

    def __init__(
        self,
        *,
        text: str = "你好，我们出发吧",
        confidence: float = 0.8,
        duration_s: float = 1.6,
        language: str | None = "zh",
        delay_s: float = 0.0,
        load_delay_s: float = 0.0,
    ) -> None:
        self.loaded = False
        self.load_delay_s = load_delay_s
        self.text = text
        self.confidence = confidence
        self.duration_s = duration_s
        self.language = language
        self.delay_s = delay_s
        self.calls: list[dict[str, object]] = []

    @property
    def is_loaded(self) -> bool:
        return self.loaded

    def load(self) -> None:
        if self.load_delay_s:
            time.sleep(self.load_delay_s)
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        self.calls.append({"bytes": len(pcm), "sample_rate": sample_rate, "lang": lang})
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return Transcript(
            text=self.text,
            confidence=self.confidence,
            duration_s=self.duration_s,
            language=self.language,
        )


def _client(
    adapter: FakeAdapter, *, timeout_s: float = 15.0, token: str | None = None
) -> TestClient:
    service = AsrService(adapter, timeout_s=timeout_s)
    return TestClient(create_app(asr_service=service, token=token))


def test_transcribe_returns_text_and_confidence() -> None:
    adapter = FakeAdapter()
    response = _client(adapter).post(
        "/asr?request_id=r1", content=PCM, headers={"Content-Type": PCM_MEDIA_TYPE}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "你好，我们出发吧"
    assert body["confidence"] == 0.8
    assert body["duration_s"] == 1.6
    assert body["language"] == "zh"
    assert adapter.calls == [{"bytes": len(PCM), "sample_rate": 16000, "lang": None}]


def test_model_load_does_not_consume_recognition_timeout() -> None:
    """加载是启动成本，不能算进 15s 识别预算（真机首次加载 small > 15s）。"""
    adapter = FakeAdapter(load_delay_s=0.05)
    response = _client(adapter, timeout_s=0.01).post(
        "/asr?request_id=r1", content=PCM, headers={"Content-Type": PCM_MEDIA_TYPE}
    )

    assert response.status_code == 200
    assert adapter.loaded is True


def test_empty_body_is_a_quiet_result_not_an_error() -> None:
    """空体不是错误：返回空文本，而且不要惊动适配器（省一次模型加载）。"""
    adapter = FakeAdapter()
    response = _client(adapter).post("/asr?request_id=r2", content=b"")

    assert response.status_code == 200
    assert response.json()["text"] == ""
    assert response.json()["confidence"] == 0.0
    assert adapter.calls == []


def test_hallucinated_text_is_swallowed() -> None:
    """静音幻听（字幕组署名）绝不能流到 LLM，否则角色会念「谢谢观看」。"""
    adapter = FakeAdapter(text="谢谢观看", confidence=0.9, duration_s=3.0)
    response = _client(adapter).post("/asr?request_id=r3", content=PCM)

    assert response.status_code == 200
    assert response.json()["text"] == ""
    assert response.json()["confidence"] == 0.0


def test_timeout_becomes_dp_asr_002() -> None:
    adapter = FakeAdapter(delay_s=0.05)
    response = _client(adapter, timeout_s=0.01).post("/asr?request_id=r4", content=PCM)

    assert response.status_code == 500
    body = response.json()
    assert body["code"] == CODE_ASR_TIMEOUT
    assert body["user_hint"]


def test_oversized_body_is_rejected_without_reading_it_all() -> None:
    adapter = FakeAdapter()
    response = _client(adapter).post(
        "/asr?request_id=r5", content=b"\x00" * (MAX_ASR_BODY_BYTES + 2)
    )

    assert response.status_code == 500
    assert response.json()["code"] == CODE_ASR_BAD_AUDIO
    assert adapter.calls == []


def test_missing_request_id_is_422() -> None:
    """request_id 是必填（§6.2/§6.3 的关联 id），缺了在参数校验层就被拦下。"""
    response = _client(FakeAdapter()).post("/asr", content=PCM)

    assert response.status_code == 422


def test_missing_token_is_unauthorized() -> None:
    """配了 token 就必须带（§6.10 runtime.json）；失败信封形状与其他错误一致。"""
    adapter = FakeAdapter()
    response = _client(adapter, token=TOKEN).post("/asr?request_id=r6", content=PCM)

    assert response.status_code == 401
    assert response.json()["code"] == CODE_UNAUTHORIZED
    assert adapter.calls == []


def test_token_is_checked_before_body_is_read() -> None:
    """鉴权必须先于读请求体：否则任何人用 4MiB 的无鉴权请求就能让 sidecar 吃满内存。"""
    adapter = FakeAdapter()
    response = _client(adapter, token=TOKEN).post(
        "/asr?request_id=r7", content=b"\x00" * (MAX_ASR_BODY_BYTES + 2)
    )

    assert response.status_code == 401
    assert adapter.calls == []
