"""POST /screen/capture：主进程抓帧 → 识图模型 → 摘要（不落盘）。"""

from __future__ import annotations

import time

from fastapi import APIRouter

from contracts.api_models import ScreenCaptureRequest, ScreenCaptureResponse
from contracts.routes import API_ROUTES
from services.vision_service import VisionService, validate_image

_ROUTE = next(route for route in API_ROUTES if route.path == "/screen/capture")


def build_screen_router(vision: VisionService, max_image_bytes: int) -> APIRouter:
    router = APIRouter()

    @router.post(
        _ROUTE.path,
        summary=_ROUTE.purpose,
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
