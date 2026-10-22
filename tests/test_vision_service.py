from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from app import create_app
from config import VisionSettings
from services.vision_service import ScreenObservation, VisionService, _parse_observation


class FakeVision:
    def __init__(self) -> None:
        self.seen: tuple[str, str, str] | None = None

    async def describe(
        self, image_base64: str, app_title: str, model: str = ""
    ) -> ScreenObservation:
        self.seen = (image_base64, app_title, model)
        return ScreenObservation(
            summary="用户在浏览器里看猫的图片。",
            interesting=True,
            confidence=0.8,
            model=model or "fake-vl",
            app_title=app_title,
            captured_at="2026-10-22T12:00:00",
        )


def test_parse_observation_accepts_plain_json() -> None:
    summary, interesting, confidence = _parse_observation(
        '{"summary":"看到一只猫","interesting":true,"confidence":0.7}'
    )
    assert summary == "看到一只猫"
    assert interesting is True
    assert confidence == 0.7


def test_parse_observation_falls_back_to_text() -> None:
    summary, interesting, _ = _parse_observation("只是一段普通文字")
    assert summary == "只是一段普通文字"
    assert interesting is True


def test_screen_capture_uses_injected_vision_service() -> None:
    fake = FakeVision()
    client = TestClient(create_app(vision_service=VisionService(fake)))
    image = base64.b64encode(b"fake-jpeg").decode("ascii")
    response = client.post(
        "/screen/capture",
        json={"image_base64": image, "app_title": "浏览器", "model": "qwen2.5vl:3b"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == "用户在浏览器里看猫的图片。"
    assert body["interesting"] is True
    assert body["vision_model"] == "qwen2.5vl:3b"
    assert body["width"] == 0
    assert fake.seen is not None
    assert fake.seen[1] == "浏览器"
    assert fake.seen[2] == "qwen2.5vl:3b"


def test_screen_capture_rejects_bad_base64() -> None:
    client = TestClient(create_app(vision_service=VisionService(FakeVision())))
    response = client.post("/screen/capture", json={"image_base64": "not base64!"})
    assert response.status_code == 500
    assert response.json()["code"] == "DP-SCR-001"


def test_vision_settings_defaults_are_local_ollama() -> None:
    settings = VisionSettings()
    assert settings.base_url.endswith(":11434/v1")
    assert settings.configured is False
