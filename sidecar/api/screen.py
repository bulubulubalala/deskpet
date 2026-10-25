"""屏幕相关路由：视觉摘要与本地 OCR（不落盘）。"""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter

from contracts.api_models import (
    ScreenCaptureRequest,
    ScreenCaptureResponse,
    ScreenOcrRequest,
    ScreenOcrResponse,
)
from contracts.routes import API_ROUTES
from services.ocr_service import OcrService
from services.vision_service import VisionService, validate_image

_CAPTURE_ROUTE = next(route for route in API_ROUTES if route.path == "/screen/capture")
_OCR_ROUTE = next(route for route in API_ROUTES if route.path == "/screen/ocr")


def build_screen_router(vision: VisionService, ocr: OcrService, max_image_bytes: int) -> APIRouter:
    router = APIRouter()

    @router.post(
        _OCR_ROUTE.path,
        summary=_OCR_ROUTE.purpose,
        response_model=ScreenOcrResponse,
    )
    async def screen_ocr(payload: ScreenOcrRequest) -> ScreenOcrResponse:
        result = await asyncio.to_thread(
            ocr.recognize, payload.image_base64, max_bytes=max_image_bytes
        )
        return ScreenOcrResponse(
            text=result.text,
            confidence=result.confidence,
            engine=result.engine,
            elapsed_ms=result.elapsed_ms,
        )

    @router.post(
        _CAPTURE_ROUTE.path,
        summary=_CAPTURE_ROUTE.purpose,
        response_model=ScreenCaptureResponse,
    )
    async def screen_capture(payload: ScreenCaptureRequest) -> ScreenCaptureResponse:
        validate_image(payload.image_base64, max_image_bytes)
        observation = await vision.observe(payload.image_base64, payload.app_title, payload.model)
        captured_at = (
            payload.captured_at or observation.captured_at or time.strftime("%Y-%m-%dT%H:%M:%S%z")
        )
        return ScreenCaptureResponse(
            ocr_text=observation.summary,
            confidence=observation.confidence,
            captured_at=captured_at,
            width=0,
            height=0,
            summary=observation.summary,
            interesting=observation.interesting,
            vision_model=observation.model,
            app_title=observation.app_title,
        )

    return router
