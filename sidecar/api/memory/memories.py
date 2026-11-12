"""文件职责：记忆条目的读写：检索、列表、写入、单删、编辑、清空。（清空记忆要一并清使用统计，并在删之前留一份底）

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_memory_routes()。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query

from contracts.api_models import (
    MemoryClearRequest,
    MemoryClearResponse,
    MemoryDeleteResponse,
    MemoryEditRequest,
    MemoryEditResponse,
    MemoryHit,
    MemoryListQuery,
    MemoryListResponse,
    MemorySearchQuery,
    MemorySearchResponse,
    MemoryWriteRequest,
    MemoryWriteResponse,
)
from core.memory import (
    MemoryDraft,
    MemoryQuery,
    RecallQuery,
    iso_time,
    parse_iso_time,
)
from services.backup_service import MemoryBackupService
from services.memory_service import MemoryService
from services.usage_service import UsageService

from .items import (
    _item,
)
from .shared import _ERROR_RESPONSES


def register_memory_routes(
    router: APIRouter,
    service: MemoryService,
    usage: UsageService,
    *,
    backup: MemoryBackupService | None = None,
) -> None:
    """记忆条目的读写：检索、列表、写入、单删、编辑、清空。"""

    @router.get(
        "/memory/search",
        summary="记忆检索：全文 + 重要度 + 时间衰减",
        response_model=MemorySearchResponse,
        responses=_ERROR_RESPONSES,
    )
    async def search(query: Annotated[MemorySearchQuery, Query()]) -> MemorySearchResponse:
        """检索一个角色的记忆；结果按总分降序（§6.4 的 0.65/0.25/0.10 权重）。"""
        vector = await service.embed_query(query.query)
        hits = service.search(
            RecallQuery(
                char_id=query.char_id,
                query=query.query,
                limit=query.limit,
                min_importance=query.min_importance,
            ),
            query_vector=vector,
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
        return MemoryListResponse(items=[_item(record) for record in records])

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

    @router.patch(
        "/memory/{memory_id}",
        summary="改一条 L0 记忆的文本与重要度（开发者模式：只动 memories 表）",
        response_model=MemoryEditResponse,
        responses=_ERROR_RESPONSES,
    )
    async def edit(
        memory_id: Annotated[int, Path(ge=1)], payload: MemoryEditRequest
    ) -> MemoryEditResponse:
        """只改 L0：原文与摘要层都不动；改完原地生效，下一轮装配就用新文本。

        不存在返回 200 + updated=False（幂等）；与另一条撞去重键时并成一条（merged=True）。
        """
        record, merged = service.edit(
            memory_id,
            text=payload.text,
            importance=payload.importance,
            kind=payload.kind,
        )
        if record is None:
            return MemoryEditResponse(updated=False)
        return MemoryEditResponse(updated=True, merged=merged, item=_item(record))

    @router.post(
        "/memory/clear",
        summary="清空一个角色的记忆（可选只清更早的）",
        response_model=MemoryClearResponse,
        responses=_ERROR_RESPONSES,
    )
    async def clear(payload: MemoryClearRequest) -> MemoryClearResponse:
        """完整重置该角色：原文、事实、摘要、状态与使用统计都不保留。

        删除不可撤销，所以先按 D9 第 5 条留一份即时快照；留底失败不拦着用户
        （库里可能正是坏到写不出来的状态），只在响应里回空串并记日志。
        """
        snapshot = await backup.snapshot_before("memory-clear") if backup is not None else None
        counts = service.reset(payload.char_id)
        usage_count = await usage.clear_character(payload.char_id)
        return MemoryClearResponse(
            deleted=sum(counts.values()) + usage_count,
            snapshot="" if snapshot is None else str(snapshot),
        )
