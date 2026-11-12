"""文件职责：关系记忆与待办：关系卡、前瞻记忆（答应过/想追问）、关系图谱。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_relation_routes()。
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Path, Query

from contracts.api_models import (
    MemoryDeleteResponse,
    MemoryGraphEdge,
    MemoryGraphNode,
    MemoryGraphQuery,
    MemoryGraphRebuildRequest,
    MemoryGraphRebuildResponse,
    MemoryGraphResponse,
    MemoryIntentionItem,
    MemoryIntentionsQuery,
    MemoryIntentionsResponse,
    MemoryIntentionWriteRequest,
    MemoryRelationItem,
    MemoryRelationUpdateRequest,
)
from core.memory import (
    MemoryRelation,
    parse_iso_time,
)
from services.memory_service import MemoryService

from .items import (
    _intention_item,
    _relation_item,
)
from .shared import _ERROR_RESPONSES


def register_relation_routes(router: APIRouter, service: MemoryService) -> None:
    """关系记忆与待办：关系卡、前瞻记忆（答应过/想追问）、关系图谱。"""

    @router.get(
        "/memory/relation",
        summary="读关系记忆",
        response_model=MemoryRelationItem,
        responses=_ERROR_RESPONSES,
    )
    async def relation(char_id: Annotated[str, Query(min_length=1)]) -> MemoryRelationItem:
        return _relation_item(service.get_relation(char_id))

    @router.put(
        "/memory/relation",
        summary="写关系记忆",
        response_model=MemoryRelationItem,
        responses=_ERROR_RESPONSES,
    )
    async def save_relation(
        payload: MemoryRelationUpdateRequest,
        char_id: Annotated[str, Query(min_length=1)],
    ) -> MemoryRelationItem:
        relation = MemoryRelation(
            char_id=char_id,
            familiarity=payload.familiarity,
            trust=payload.trust,
            warmth=payload.warmth,
            unresolved=payload.unresolved,
            recent_conflict=payload.recent_conflict,
            updated_at=time.time(),
        )
        service.save_relation(relation)
        return _relation_item(relation)

    @router.get(
        "/memory/intentions",
        summary="列出仍打开的前瞻记忆",
        response_model=MemoryIntentionsResponse,
        responses=_ERROR_RESPONSES,
    )
    async def intentions(
        query: Annotated[MemoryIntentionsQuery, Query()],
    ) -> MemoryIntentionsResponse:
        items = service.list_intentions(query.char_id, limit=query.limit)
        return MemoryIntentionsResponse(items=[_intention_item(item) for item in items])

    @router.post(
        "/memory/intentions",
        summary="新增一条前瞻记忆",
        response_model=MemoryIntentionItem,
        responses=_ERROR_RESPONSES,
    )
    async def add_intention(payload: MemoryIntentionWriteRequest) -> MemoryIntentionItem:
        item = service.add_intention(
            char_id=payload.char_id,
            text=payload.text,
            trigger_at=parse_iso_time(payload.trigger_at),
        )
        return _intention_item(item)

    @router.post(
        "/memory/intentions/{intention_id}/resolve",
        summary="完成 / 取消一条前瞻记忆",
        response_model=MemoryDeleteResponse,
        responses=_ERROR_RESPONSES,
    )
    async def resolve_intention(
        intention_id: Annotated[int, Path(ge=1)],
    ) -> MemoryDeleteResponse:
        return MemoryDeleteResponse(deleted=service.resolve_intention(intention_id))

    @router.get(
        "/memory/graph",
        summary="记忆网络：时间桶 / 事实 / 日记节点与来源边",
        response_model=MemoryGraphResponse,
        responses=_ERROR_RESPONSES,
    )
    async def graph(query: Annotated[MemoryGraphQuery, Query()]) -> MemoryGraphResponse:
        payload = service.graph(query.char_id, limit=query.limit)
        return MemoryGraphResponse(
            nodes=[MemoryGraphNode.model_validate(node) for node in payload["nodes"]],
            edges=[MemoryGraphEdge.model_validate(edge) for edge in payload["edges"]],
        )

    @router.post(
        "/memory/graph/rebuild",
        summary="重建记忆知识图谱（实体 / 关系抽取）",
        response_model=MemoryGraphRebuildResponse,
        responses=_ERROR_RESPONSES,
    )
    async def rebuild_graph(
        payload: MemoryGraphRebuildRequest,
    ) -> MemoryGraphRebuildResponse:
        result = await service.rebuild_graph(payload.char_id, now=parse_iso_time(payload.now))
        return MemoryGraphRebuildResponse(
            entities=int(result.get("entities", 0)), links=int(result.get("links", 0))
        )
