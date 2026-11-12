"""文件职责：注入预览：干跑一次下一轮的记忆装配（不调模型、不标记已用）。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_context_routes()。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from contracts.api_models import (
    MemoryContextQuery,
    MemoryContextResponse,
)
from core.prompt import build_memory_block
from services.memory_service import MemoryService

from .items import (
    _preview_sections,
)
from .shared import _ERROR_RESPONSES


def register_context_routes(router: APIRouter, service: MemoryService) -> None:
    """注入预览：干跑一次下一轮的记忆装配（不调模型、不标记已用）。"""

    @router.get(
        "/memory/context",
        summary="开发者模式「注入上下文」页：干跑一次下一轮的记忆装配（不调模型）",
        response_model=MemoryContextResponse,
        responses=_ERROR_RESPONSES,
    )
    async def context(query: Annotated[MemoryContextQuery, Query()]) -> MemoryContextResponse:
        """干跑 recall + 裁剪：不调 LLM、不 mark_used，只回答「下一轮会注入什么」。"""
        recall = service.preview_context(char_id=query.char_id, query=query.query)
        budgets = service.budgets
        return MemoryContextResponse(
            char_id=query.char_id,
            query=query.query,
            empty=recall.is_empty,
            total_tokens=recall.tokens,
            budget_tokens=sum(budgets.values()),
            dropped=list(recall.dropped),
            injected_ids=list(recall.injected_ids),
            sections=_preview_sections(recall, budgets),
            text=build_memory_block(recall),
        )
