"""文件职责：SQLite 行 → core.memory 数据类的映射（列顺序与建表一致）。"""

from __future__ import annotations

from typing import Any

from core.memory import (
    DiaryEntry,
    MemoryEntity,
    MemoryIntention,
    MemoryLink,
    MemoryPeriod,
    MemoryRecord,
)


def _to_period(row: Any) -> MemoryPeriod:
    """列顺序与 list_periods / get_period 的 SELECT 保持一致。"""
    return MemoryPeriod(
        period_id=int(row[0]),
        char_id=str(row[1]),
        level=str(row[2]),
        period_start=float(row[3]),
        period_end=float(row[4]),
        day_key=str(row[5]),
        label=str(row[6]),
        summary=str(row[7]),
        source_hash=str(row[8]),
        model_id=str(row[9]),
        edited_at=float(row[10]),
        created_at=float(row[11]),
        updated_at=float(row[12]),
        archived_at=float(row[13]),
        strength=float(row[14]) if len(row) > 14 else 0.5,
        state=str(row[15]) if len(row) > 15 else "active",
        pinned=bool(row[16]) if len(row) > 16 else False,
    )


def _to_diary(row: Any) -> DiaryEntry:
    return DiaryEntry(
        entry_id=int(row[0]),
        char_id=str(row[1]),
        text=str(row[2]),
        occurred_at=float(row[3]),
        mood=str(row[4]),
        tags=str(row[5]),
        created_at=float(row[6]),
        updated_at=float(row[7]),
    )


def _to_entity(row: Any) -> MemoryEntity:
    return MemoryEntity(
        entity_id=int(row[0]),
        char_id=str(row[1]),
        name=str(row[2]),
        kind=str(row[3]),
        aliases=str(row[4]),
        created_at=float(row[5]),
        updated_at=float(row[6]),
    )


def _to_link(row: Any) -> MemoryLink:
    return MemoryLink(
        link_id=int(row[0]),
        char_id=str(row[1]),
        from_type=str(row[2]),
        from_id=int(row[3]),
        to_type=str(row[4]),
        to_id=int(row[5]),
        relation=str(row[6]),
        weight=float(row[7]),
        confidence=float(row[8]),
        created_at=float(row[9]),
    )


def _to_intention(row: Any) -> MemoryIntention:
    return MemoryIntention(
        intention_id=int(row[0]),
        char_id=str(row[1]),
        text=str(row[2]),
        trigger_at=float(row[3]),
        trigger_context=str(row[4]),
        status=str(row[5]),
        created_at=float(row[6]),
        resolved_at=float(row[7]),
    )


def _to_record(row: Any) -> MemoryRecord:
    """把一条 memories 行摊成 MemoryRecord（列顺序与各 SELECT 保持一致）。"""
    return MemoryRecord(
        memory_id=int(row[0]),
        char_id=str(row[1]),
        kind=str(row[2]),
        tier=str(row[3]),
        text=str(row[4]),
        importance=float(row[5]),
        created_at=float(row[6]),
        last_used_at=float(row[7]) if row[7] is not None else None,
        used_count=int(row[8]),
        source_msg_ids=str(row[9]),
    )
