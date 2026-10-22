"""文件职责：记忆管理路由（需求 §6.3 / §6.4 / §5 F3）：检索、写入、列表、单删、编辑、清空。

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
    MemoryContextItem,
    MemoryContextQuery,
    MemoryContextResponse,
    MemoryContextSection,
    MemoryDeleteResponse,
    MemoryEditRequest,
    MemoryEditResponse,
    MemoryHit,
    MemoryListItem,
    MemoryListQuery,
    MemoryListResponse,
    MemoryMessageItem,
    MemoryMessagesQuery,
    MemoryMessagesResponse,
    MemorySearchQuery,
    MemorySearchResponse,
    MemoryWriteRequest,
    MemoryWriteResponse,
)
from contracts.errors import ErrorEnvelope
from core.memory import (
    MemoryDraft,
    MemoryQuery,
    MemoryRecord,
    RecallContext,
    RecallQuery,
    estimate_tokens,
    iso_time,
    parse_iso_time,
)
from core.prompt import build_memory_block
from services.memory_service import MemoryService
from services.usage_service import UsageService

#: 可能的失败信封写进 OpenAPI，前端据此写错误处理（DP-MEM-001 / 002 / 003 都是 500）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope},
    500: {"model": ErrorEnvelope},
}


#: 注入预览的六段顺序与标题（与 §6.4 的层一一对应；名字用 sidecar 侧的 key，title 只给人看）
_CONTEXT_SECTIONS: tuple[tuple[str, str], ...] = (
    ("observations", "行为观察"),
    ("l3", "长期印象（L3）"),
    ("l2", "近期梗概（L2）"),
    ("l1", "阶段摘要（L1）"),
    ("facts", "长期记忆（L0）"),
    ("history", "最近原文"),
)


def _item(record: MemoryRecord) -> MemoryListItem:
    """把存储层记录摊成管理界面的列表项（时间字段在边界上都是 ISO 字符串）。"""
    return MemoryListItem(
        id=record.memory_id,
        kind=record.kind,
        tier=record.tier,
        text=record.text,
        importance=record.importance,
        created_at=iso_time(record.created_at),
        last_used_at=iso_time(record.last_used_at),
        used_count=record.used_count,
    )


def _preview_sections(recall: RecallContext, budgets: dict[str, int]) -> list[MemoryContextSection]:
    """把一次装配结果摊成六段，每段带预算、用量与「是否被裁过」。"""
    raw: dict[str, list[MemoryContextItem]] = {
        "observations": [
            MemoryContextItem(
                text=item.text,
                tokens=estimate_tokens(item.text),
                ref_id=item.memory_id,
                kind=item.kind,
                importance=item.importance,
            )
            for item in recall.observations
        ],
        "l3": (
            [MemoryContextItem(text=recall.impressions, tokens=estimate_tokens(recall.impressions))]
            if recall.impressions
            else []
        ),
        "l2": [
            MemoryContextItem(text=text, tokens=estimate_tokens(text)) for text in recall.episodes
        ],
        "l1": [
            MemoryContextItem(text=text, tokens=estimate_tokens(text)) for text in recall.summaries
        ],
        "facts": [
            MemoryContextItem(
                text=fact.text,
                tokens=estimate_tokens(fact.text),
                ref_id=fact.memory_id,
                kind=fact.kind,
                importance=fact.importance,
            )
            for fact in recall.facts
        ],
        "history": [
            MemoryContextItem(text=turn.text, tokens=estimate_tokens(turn.text), role=turn.role)
            for turn in recall.history
        ],
    }
    return [
        MemoryContextSection(
            name=name,
            title=title,
            budget_tokens=budgets.get(name, 0),
            used_tokens=sum(item.tokens for item in raw[name]),
            dropped=name in recall.dropped,
            items=raw[name],
        )
        for name, title in _CONTEXT_SECTIONS
    ]


def build_memory_router(service: MemoryService, usage: UsageService) -> APIRouter:
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
        record, merged = service.edit(memory_id, text=payload.text, importance=payload.importance)
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
        """完整重置该角色：原文、事实、摘要、状态与使用统计都不保留。"""
        counts = service.reset(payload.char_id)
        usage_count = await usage.clear_character(payload.char_id)
        return MemoryClearResponse(deleted=sum(counts.values()) + usage_count)

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

    return router
