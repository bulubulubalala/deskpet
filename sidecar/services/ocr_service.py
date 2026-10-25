"""本地 OCR（F7）：优先 RapidOCR，未安装时明确报错而不是静默退回视觉模型。"""

from __future__ import annotations

import base64
import binascii
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from contracts.errors import CODE_SCR_CAPTURE_FAILED, CODE_SCR_OCR_FAILED
from core.errors import ScreenError

MAX_OCR_CHARS = 4000


@dataclass(frozen=True, slots=True)
class OcrResult:
    text: str
    confidence: float
    engine: str
    elapsed_ms: int


class OcrProvider(Protocol):
    def recognize(self, image: bytes) -> OcrResult: ...


class RapidOcrProvider:
    """RapidOCR 延迟加载；首次调用才加载模型，后续复用实例。"""

    def __init__(self) -> None:
        self._engine: object | None = None
        self._lock = threading.Lock()

    def recognize(self, image: bytes) -> OcrResult:
        started = time.perf_counter()
        engine = self._get_engine()
        result = engine(image)  # type: ignore[operator]
        texts = tuple(str(item) for item in getattr(result, "txts", ()) if str(item).strip())
        scores = tuple(float(item) for item in getattr(result, "scores", ()))
        text = "\n".join(texts)[:MAX_OCR_CHARS]
        confidence = sum(scores) / len(scores) if scores else 0.0
        return OcrResult(
            text=text,
            confidence=max(0.0, min(1.0, confidence)),
            engine="rapidocr",
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )

    def _get_engine(self) -> object:
        with self._lock:
            if self._engine is not None:
                return self._engine
            try:
                from rapidocr import RapidOCR
            except ImportError as exc:
                raise ScreenError(
                    CODE_SCR_OCR_FAILED,
                    "本地 OCR 未安装",
                    user_hint="安装 rapidocr 后才能使用离线屏幕文字识别。",
                ) from exc
            self._engine = RapidOCR()
            return self._engine


class OcrService:
    def __init__(self, provider: OcrProvider | None = None) -> None:
        self._provider = provider or RapidOcrProvider()

    def recognize(self, image_base64: str, *, max_bytes: int = 8_000_000) -> OcrResult:
        if len(image_base64) > max_bytes * 4 // 3 + 16:
            raise ScreenError(CODE_SCR_CAPTURE_FAILED, "屏幕帧超过大小上限")
        try:
            image = base64.b64decode(image_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ScreenError(CODE_SCR_CAPTURE_FAILED, "屏幕帧不是合法 base64") from exc
        try:
            return self._provider.recognize(image)
        except ScreenError:
            raise
        except Exception as exc:
            raise ScreenError(
                CODE_SCR_OCR_FAILED,
                "本地 OCR 识别失败：" + type(exc).__name__,
                user_hint="可以关掉 OCR，先用视觉模型看屏幕。",
            ) from exc


def build_ocr_service() -> OcrService:
    return OcrService()
