"""本地 OCR 用例层测试（F7）。"""

from __future__ import annotations

import base64

import pytest

from contracts.errors import CODE_SCR_CAPTURE_FAILED
from core.errors import ScreenError
from services.ocr_service import OcrResult, OcrService


class FakeProvider:
    def __init__(self) -> None:
        self.images: list[bytes] = []

    def recognize(self, image: bytes) -> OcrResult:
        self.images.append(image)
        return OcrResult(text="你好\nworld", confidence=0.91, engine="fake", elapsed_ms=12)


def test_ocr_decodes_and_delegates() -> None:
    provider = FakeProvider()
    service = OcrService(provider)

    result = service.recognize(base64.b64encode(b"image-bytes").decode("ascii"))

    assert result.text == "你好\nworld"
    assert provider.images == [b"image-bytes"]


def test_ocr_rejects_bad_base64() -> None:
    service = OcrService(FakeProvider())

    with pytest.raises(ScreenError) as raised:
        service.recognize("not base64 !!!")

    assert raised.value.code == CODE_SCR_CAPTURE_FAILED
