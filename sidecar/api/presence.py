"""在场快照与主动决策的路由（F9 / F5）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from contracts.api_models import PresenceRequest, PresenceResponse
from contracts.errors import ErrorEnvelope
from services.presence_service import PresenceService

_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {401: {"model": ErrorEnvelope}}


def build_presence_router(service: PresenceService) -> APIRouter:
    router = APIRouter(tags=["presence"])

    @router.post(
        "/presence",
        summary="上报在场快照并取得主动决策（F9 / F5）",
        response_model=PresenceResponse,
        responses=_ERROR_RESPONSES,
    )
    async def apply(request: PresenceRequest) -> PresenceResponse:
        return service.apply(request)

    return router
