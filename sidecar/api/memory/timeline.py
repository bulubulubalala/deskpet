"""文件职责：时间金字塔与手动日记：周/月摘要列表与详情、重建、补算，以及日记的增删改查。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_timeline_routes()。
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Path, Query

from contracts.api_models import (
    MemoryDeleteResponse,
    MemoryDiaryEntry,
    MemoryDiaryListResponse,
    MemoryDiaryPatchRequest,
    MemoryDiaryQuery,
    MemoryDiaryWriteRequest,
    MemoryPeriodDetail,
    MemoryPeriodEditRequest,
    MemoryPeriodItem,
    MemoryTimelineBackfillRequest,
    MemoryTimelineQuery,
    MemoryTimelineRebuildRequest,
    MemoryTimelineRebuildResponse,
    MemoryTimelineResponse,
)
from core.memory import (
    DiaryDraft,
    parse_iso_time,
)
from services.memory_service import MemoryService

from .items import (
    _diary_item,
    _period_item,
)
from .shared import _ERROR_RESPONSES


def register_timeline_routes(router: APIRouter, service: MemoryService) -> None:
    """时间金字塔与手动日记：周/月摘要列表与详情、重建、补算，以及日记的增删改查。"""

    @router.get(
        "/memory/timeline",
        summary="按时间倒序列出 Episode / Day / Week / Month",
        response_model=MemoryTimelineResponse,
        responses=_ERROR_RESPONSES,
    )
    async def timeline(
        query: Annotated[MemoryTimelineQuery, Query()],
    ) -> MemoryTimelineResponse:
        levels = tuple(part.strip() for part in query.levels.split(",") if part.strip())
        periods = service.list_timeline(
            query.char_id,
            levels=levels,
            limit=query.limit,
            since=parse_iso_time(query.from_ts),
            until=parse_iso_time(query.to_ts),
        )
        return MemoryTimelineResponse(items=[_period_item(period) for period in periods])

    @router.post(
        "/memory/timeline/rebuild",
        summary="手动整理一次时间线（Episode → Day → Week → Month）",
        response_model=MemoryTimelineRebuildResponse,
        responses=_ERROR_RESPONSES,
    )
    async def timeline_rebuild(
        payload: MemoryTimelineRebuildRequest,
    ) -> MemoryTimelineRebuildResponse:
        result = await service.rebuild_timeline(payload.char_id, now=parse_iso_time(payload.now))
        return MemoryTimelineRebuildResponse(
            episode=int(result.get("episode", 0)),
            day=int(result.get("day", 0)),
            week=int(result.get("week", 0)),
            month=int(result.get("month", 0)),
        )

    @router.post(
        "/memory/timeline/backfill",
        summary="把历史原文补成时间线",
        response_model=MemoryTimelineRebuildResponse,
        responses=_ERROR_RESPONSES,
    )
    async def timeline_backfill(
        payload: MemoryTimelineBackfillRequest,
    ) -> MemoryTimelineRebuildResponse:
        result = await service.backfill_timeline(payload.char_id, days=payload.days)
        return MemoryTimelineRebuildResponse(
            episode=int(result.get("episode", 0)),
            day=int(result.get("day", 0)),
            week=int(result.get("week", 0)),
            month=int(result.get("month", 0)),
        )

    @router.patch(
        "/memory/timeline/{period_id}",
        summary="编辑 / 置顶一个时间桶",
        response_model=MemoryPeriodItem,
        responses=_ERROR_RESPONSES,
    )
    async def edit_period(
        period_id: Annotated[int, Path(ge=1)], payload: MemoryPeriodEditRequest
    ) -> MemoryPeriodItem:
        period = service.edit_period(
            period_id,
            summary=payload.summary,
            label=payload.label,
            pinned=payload.pinned,
        )
        if period is None:
            raise KeyError(str(period_id))
        return _period_item(period)

    @router.get(
        "/memory/timeline/{period_id}",
        summary="时间桶详情与来源",
        response_model=MemoryPeriodDetail,
        responses=_ERROR_RESPONSES,
    )
    async def timeline_detail(period_id: Annotated[int, Path(ge=1)]) -> MemoryPeriodDetail:
        found = service.period_detail(period_id)
        if found is None:
            raise KeyError(str(period_id))
        period, sources = found
        item = _period_item(period)
        return MemoryPeriodDetail(**item.model_dump(), sources=sources)

    @router.get(
        "/memory/diary",
        summary="列出某个角色的手动日记",
        response_model=MemoryDiaryListResponse,
        responses=_ERROR_RESPONSES,
    )
    async def diary(query: Annotated[MemoryDiaryQuery, Query()]) -> MemoryDiaryListResponse:
        entries = service.list_diary(query.char_id, limit=query.limit)
        return MemoryDiaryListResponse(items=[_diary_item(entry) for entry in entries])

    @router.post(
        "/memory/diary",
        summary="写一条手动日记",
        response_model=MemoryDiaryEntry,
        responses=_ERROR_RESPONSES,
    )
    async def add_diary(payload: MemoryDiaryWriteRequest) -> MemoryDiaryEntry:
        entry = service.add_diary(
            DiaryDraft(
                char_id=payload.char_id,
                text=payload.text,
                occurred_at=parse_iso_time(payload.occurred_at) or time.time(),
                mood=payload.mood,
                tags=payload.tags,
            )
        )
        return _diary_item(entry)

    @router.patch(
        "/memory/diary/{entry_id}",
        summary="改一条手动日记",
        response_model=MemoryDiaryEntry,
        responses=_ERROR_RESPONSES,
    )
    async def edit_diary(
        entry_id: Annotated[int, Path(ge=1)], payload: MemoryDiaryPatchRequest
    ) -> MemoryDiaryEntry:
        entry = service.update_diary(
            entry_id, text=payload.text, mood=payload.mood, tags=payload.tags
        )
        if entry is None:
            raise KeyError(str(entry_id))
        return _diary_item(entry)

    @router.delete(
        "/memory/diary/{entry_id}",
        summary="删一条手动日记",
        response_model=MemoryDeleteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def delete_diary(entry_id: Annotated[int, Path(ge=1)]) -> MemoryDeleteResponse:
        return MemoryDeleteResponse(deleted=service.delete_diary(entry_id))
