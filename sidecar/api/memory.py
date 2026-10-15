"""文件职责：记忆管理路由（需求 §6.3 / §6.4 / §5 F3）：检索、写入、列表、单删、清空。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_memory_router()。
约定：
- 这里不吞异常：MemoryStoreError（DP-MEM-*）交给 api/error_handlers.py 统一转失败信封。
  与对话链路的区别就在这——用户主动操作时，失败必须让他看见原因（§6.4 / §6.7 A 级）。
- 时间字段在边界上都是 ISO 字符串，换算只发生在 core.memory 的 iso_time / parse_iso_time。
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Path, Query

from contracts.api_models import (
    MemoryClearRequest,
    MemoryClearResponse,
    MemoryDeleteResponse,
    MemoryHit,
    MemoryListItem,
    MemoryListQuery,
    MemoryListResponse,
    MemorySearchQuery,
    MemorySearchResponse,
    MemoryWriteRequest,
    MemoryWriteResponse,
)
from contracts.errors import ErrorEnvelope
from core.memory import MemoryDraft, MemoryQuery, RecallQuery, iso_time, parse_iso_time
from services.memory_service import MemoryService

#: 可能的失败信封写进 OpenAPI，前端据此写错误处理（DP-MEM-001 / 002 / 003 都是 500）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}


def build_memory_router(service: MemoryService) -> APIRouter:
    """把五条记忆路由挂成真实现；桩在 api/stubs.py 里对应删除。"""
    router = APIRouter(tags=["memory"])

    @router.get(
        "/memory/search",
        summary="记忆检索：全文 + 重要度 + 时间衰减",
        response_model=MemorySearchResponse,
        responses=_ERROR_RESPONSES,
    )
    async def search(query: Annotated[MemorySearchQuery, Query()]) -> MemorySearchResponse:
        """检索一个角色的记忆；结果按总分降序（§6.4 的 0.65/0.25/0.10 权重）。"""
        hits = service.search(
            RecallQuery(
                char_id=query.char_id,
                query=query.query,
                limit=query.limit,
                min_importance=query.min_importance,
            )
        )
        return MemorySearchResponse(
            items=[
                MemoryHit(
                    id=hit.memory_id,
                    text=hit.text,
                    importance=hit.importance,
                    occurred_at=iso_time(hit.occurred_at),
                    score=hit.score,
                )
                for hit in hits
            ]
        )

    @router.get(
        "/memory/list",
        summary="列出一个角色的记忆（管理界面用）",
        response_model=MemoryListResponse,
        responses=_ERROR_RESPONSES,
    )
    async def list_memories(query: Annotated[MemoryListQuery, Query()]) -> MemoryListResponse:
        """按重要度、时间倒序列出记忆；kind / tier 留空表示不限。"""
        records = service.list_memories(
            MemoryQuery(
                char_id=query.char_id,
                kind=query.kind,
                tier=query.tier,
                min_importance=query.min_importance,
                limit=query.limit,
            )
        )
        return MemoryListResponse(
            items=[
                MemoryListItem(
                    id=record.memory_id,
                    kind=record.kind,
                    tier=record.tier,
                    text=record.text,
                    importance=record.importance,
                    created_at=iso_time(record.created_at),
                    last_used_at=iso_time(record.last_used_at),
                    used_count=record.used_count,
                )
                for record in records
            ]
        )

    @router.post(
        "/memory/write",
        summary="写入记忆（带去重）",
        response_model=MemoryWriteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def write(payload: MemoryWriteRequest) -> MemoryWriteResponse:
        """手动写入一条记忆；同一角色 + 同一句话算重复，只抬重要度（deduped=True）。"""
        draft = MemoryDraft(
            char_id=payload.char_id,
            kind=payload.kind,
            text=payload.text,
            importance=payload.importance,
            source=payload.source,
            occurred_at=parse_iso_time(payload.occurred_at) or None,
        )
        memory_id, deduped = service.remember(draft)
        return MemoryWriteResponse(id=memory_id, deduped=deduped)

    @router.delete(
        "/memory/{memory_id}",
        summary="单条删除（隐私：让用户能要求忘掉某件事）",
        response_model=MemoryDeleteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def delete(memory_id: Annotated[int, Path(ge=1)]) -> MemoryDeleteResponse:
        """删除一条记忆；不存在也返回 200 + deleted=False（幂等，不报错）。"""
        return MemoryDeleteResponse(deleted=service.delete(memory_id))

    @router.post(
        "/memory/clear",
        summary="清空一个角色的记忆（可选只清更早的）",
        response_model=MemoryClearResponse,
        responses=_ERROR_RESPONSES,
    )
    async def clear(payload: MemoryClearRequest) -> MemoryClearResponse:
        """清空记忆；给了 keep_days 就只清更早的（保留最近这几天）。"""
        deleted = service.clear(payload.char_id, keep_days=payload.keep_days)
        return MemoryClearResponse(deleted=deleted)

    return router
