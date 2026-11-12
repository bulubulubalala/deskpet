"""文件职责：记忆域「数据库行 → 接口模型」的映射，以及注入预览的分段。

为什么单独成模块：这些函数只做形状转换（不含业务判断），六个路由模块都要用；
放在路由文件里会让「接口长什么样」和「数据怎么变」混在一起。

依赖方向：api -> contracts + core（只读数据结构）；不 import services / adapters。
谁调用：api/memory/ 下各路由模块。
"""

from __future__ import annotations

from contracts.api_models import (
    MemoryContextItem,
    MemoryContextSection,
    MemoryDiaryEntry,
    MemoryIntentionItem,
    MemoryListItem,
    MemoryPeriodItem,
    MemoryRelationItem,
    MemorySummaryItem,
)
from core.memory import (
    DiaryEntry,
    MemoryIntention,
    MemoryPeriod,
    MemoryRecord,
    MemoryRelation,
    RecallContext,
    SummarySnippet,
    estimate_tokens,
    iso_time,
)

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
        char_id=record.char_id,
        kind=record.kind,
        tier=record.tier,
        text=record.text,
        importance=record.importance,
        created_at=iso_time(record.created_at),
        last_used_at=iso_time(record.last_used_at),
        used_count=record.used_count,
        source_msg_ids=record.source_msg_ids,
    )


def _summary_item(record: SummarySnippet) -> MemorySummaryItem:
    return MemorySummaryItem(
        id=record.summary_id,
        char_id=record.char_id,
        tier=record.tier,
        text=record.text,
        covers_from=iso_time(record.covers_from),
        covers_to=iso_time(record.covers_to),
        source_ids=record.source_ids,
        created_at=iso_time(record.created_at),
        archived_at=iso_time(record.archived_at),
    )


def _intention_item(item: MemoryIntention) -> MemoryIntentionItem:
    return MemoryIntentionItem(
        id=item.intention_id,
        char_id=item.char_id,
        text=item.text,
        trigger_at=iso_time(item.trigger_at),
        trigger_context=item.trigger_context,
        status=item.status,
        created_at=iso_time(item.created_at),
    )


def _period_item(period: MemoryPeriod) -> MemoryPeriodItem:
    return MemoryPeriodItem(
        id=period.period_id,
        char_id=period.char_id,
        level=period.level,
        period_start=iso_time(period.period_start),
        period_end=iso_time(period.period_end),
        label=period.label,
        day_key=period.day_key,
        summary=period.summary,
        edited=period.edited_at > 0,
        pinned=period.pinned,
    )


def _diary_item(entry: DiaryEntry) -> MemoryDiaryEntry:
    return MemoryDiaryEntry(
        id=entry.entry_id,
        char_id=entry.char_id,
        text=entry.text,
        occurred_at=iso_time(entry.occurred_at),
        mood=entry.mood,
        tags=entry.tags,
        created_at=iso_time(entry.created_at),
        updated_at=iso_time(entry.updated_at),
    )


def _relation_item(relation: MemoryRelation) -> MemoryRelationItem:
    return MemoryRelationItem(
        char_id=relation.char_id,
        familiarity=relation.familiarity,
        trust=relation.trust,
        warmth=relation.warmth,
        unresolved=relation.unresolved,
        recent_conflict=relation.recent_conflict,
        updated_at=iso_time(relation.updated_at),
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


__all__ = [
    "_CONTEXT_SECTIONS",
    "_diary_item",
    "_intention_item",
    "_item",
    "_period_item",
    "_preview_sections",
    "_relation_item",
    "_summary_item",
]
