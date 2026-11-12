"""文件职责：原文与摘要的核对/纠错：翻原文、改一句、删一句、看摘要、改摘要。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_message_routes()。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query

from contracts.api_models import (
    MemoryDeleteResponse,
    MemoryMessageEditRequest,
    MemoryMessageItem,
    MemoryMessagesQuery,
    MemoryMessagesResponse,
    MemorySummariesQuery,
    MemorySummariesResponse,
    MemorySummaryEditRequest,
    MemorySummaryItem,
)
from core.memory import (
    iso_time,
)
from services.memory_service import MemoryService

from .items import (
    _summary_item,
)
from .shared import _ERROR_RESPONSES


def register_message_routes(router: APIRouter, service: MemoryService) -> None:
    """原文与摘要的核对/纠错：翻原文、改一句、删一句、看摘要、改摘要。"""

    @router.get(
        "/memory/messages",
        summary="开发者模式「原文」页：按 id 倒序翻历史原文（只读）",
        response_model=MemoryMessagesResponse,
        responses=_ERROR_RESPONSES,
    )
    async def messages(query: Annotated[MemoryMessagesQuery, Query()]) -> MemoryMessagesResponse:
        """只读：原文是压缩链路的输入，改了会破坏 covered_by 的覆盖关系（方案 §3.3）。"""
        # 多取一条来判断「还有更早的」，返回前切掉
        rows = service.list_messages(
            query.char_id, limit=query.limit + 1, before_id=query.before_id
        )
        has_more = len(rows) > query.limit
        return MemoryMessagesResponse(
            items=[
                MemoryMessageItem(
                    message_id=row.message_id,
                    session_id=row.session_id,
                    role=row.role,
                    text=row.text,
                    created_at=iso_time(row.ts),
                    token_len=row.token_len,
                    covered_by=row.covered_by,
                )
                for row in rows[: query.limit]
            ],
            has_more=has_more,
        )

    @router.patch(
        "/memory/messages/{message_id}",
        summary="开发者模式：编辑一条原文（同步 FTS）",
        response_model=MemoryMessageItem,
        responses=_ERROR_RESPONSES,
    )
    async def edit_message(
        message_id: Annotated[int, Path(ge=1)], payload: MemoryMessageEditRequest
    ) -> MemoryMessageItem:
        row = service.edit_message(message_id, text=payload.text)
        if row is None:
            raise KeyError(str(message_id))
        return MemoryMessageItem(
            message_id=row.message_id,
            session_id=row.session_id,
            role=row.role,
            text=row.text,
            created_at=iso_time(row.ts),
            token_len=row.token_len,
            covered_by=row.covered_by,
        )

    @router.delete(
        "/memory/messages/{message_id}",
        summary="开发者模式：删除一条原文",
        response_model=MemoryDeleteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def delete_message(message_id: Annotated[int, Path(ge=1)]) -> MemoryDeleteResponse:
        return MemoryDeleteResponse(deleted=service.delete_message(message_id))

    @router.get(
        "/memory/summaries",
        summary="开发者模式：列出全部 L1/L2/L3 摘要",
        response_model=MemorySummariesResponse,
        responses=_ERROR_RESPONSES,
    )
    async def summaries(
        query: Annotated[MemorySummariesQuery, Query()],
    ) -> MemorySummariesResponse:
        records = service.list_all_summaries(query.char_id, limit=query.limit)
        return MemorySummariesResponse(items=[_summary_item(record) for record in records])

    @router.patch(
        "/memory/summaries/{summary_id}",
        summary="开发者模式：编辑一条摘要正文",
        response_model=MemorySummaryItem,
        responses=_ERROR_RESPONSES,
    )
    async def edit_summary(
        summary_id: Annotated[int, Path(ge=1)], payload: MemorySummaryEditRequest
    ) -> MemorySummaryItem:
        record = service.edit_summary(summary_id, text=payload.text)
        if record is None:
            raise KeyError(str(summary_id))
        return _summary_item(record)

    @router.delete(
        "/memory/summaries/{summary_id}",
        summary="开发者模式：删除一条摘要",
        response_model=MemoryDeleteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def delete_summary(summary_id: Annotated[int, Path(ge=1)]) -> MemoryDeleteResponse:
        return MemoryDeleteResponse(deleted=service.delete_summary(summary_id))
