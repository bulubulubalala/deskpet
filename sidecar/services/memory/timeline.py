"""文件职责：时间金字塔与手动日记：周/月摘要的重建、补算、查看、编辑，以及日记增删改查。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

from collections.abc import Sequence

from core.memory import (
    DiaryDraft,
    DiaryEntry,
    MemoryBackendError,
    MemoryPeriod,
)

from .base import MemoryServiceBase


class TimelineMixin(MemoryServiceBase):
    """时间金字塔与手动日记：周/月摘要的重建、补算、查看、编辑，以及日记增删改查。"""

    def list_timeline(
        self,
        char_id: str,
        *,
        levels: Sequence[str] = (),
        limit: int = 60,
        since: float = 0.0,
        until: float = 0.0,
    ) -> list[MemoryPeriod]:
        store = self._require_store()
        try:
            return store.list_periods(char_id, levels=levels, limit=limit, since=since, until=until)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def period_detail(self, period_id: int) -> tuple[MemoryPeriod, list[tuple[str, int]]] | None:
        store = self._require_store()
        try:
            period = store.get_period(period_id)
            return None if period is None else (period, store.period_sources(period_id))
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def edit_period(
        self,
        period_id: int,
        *,
        summary: str,
        label: str | None = None,
        pinned: bool | None = None,
    ) -> MemoryPeriod | None:
        store = self._require_store()
        try:
            return store.update_period(
                period_id, summary=summary, label=label, pinned=pinned, now=self._now()
            )
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    async def backfill_timeline(
        self, char_id: str, *, days: int = 180, now: float = 0.0
    ) -> dict[str, int]:
        """把历史原文补成时间线；没有注入时间线服务时返回空计数。"""
        timeline = self._timeline
        backfill = getattr(timeline, "backfill", None)
        if not callable(backfill):
            return {}
        result = await backfill(char_id, days=days, now=now or self._now())
        return dict(result) if isinstance(result, dict) else {}

    async def rebuild_timeline(self, char_id: str, *, now: float = 0.0) -> dict[str, int]:
        """手动触发一次时间线整理；没有注入时间线服务时返回空计数。"""
        timeline = self._timeline
        consolidate = getattr(timeline, "consolidate", None)
        if not callable(consolidate):
            return {}
        result = await consolidate(char_id, now=now or self._now())
        return dict(result) if isinstance(result, dict) else {}

    def _schedule_timeline(self, char_id: str) -> None:
        schedule = getattr(self._timeline, "schedule", None)
        if callable(schedule) and char_id:
            schedule(char_id)

    def list_diary(self, char_id: str, *, limit: int = 50) -> list[DiaryEntry]:
        store = self._require_store()
        try:
            return store.list_diary(char_id, limit=limit)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def add_diary(self, draft: DiaryDraft, *, now: float = 0.0) -> DiaryEntry:
        store = self._require_store()
        try:
            entry = store.add_diary(draft, now=now)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc
        self._schedule_timeline(draft.char_id)
        return entry

    def update_diary(
        self, entry_id: int, *, text: str, mood: str | None = None, tags: str | None = None
    ) -> DiaryEntry | None:
        store = self._require_store()
        try:
            entry = store.update_diary(entry_id, text=text, mood=mood, tags=tags)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc
        if entry is not None:
            self._schedule_timeline(entry.char_id)
        return entry

    def delete_diary(self, entry_id: int) -> bool:
        store = self._require_store()
        try:
            entry = store.get_diary(entry_id)
            deleted = store.delete_diary(entry_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc
        if deleted and entry is not None:
            self._schedule_timeline(entry.char_id)
        return deleted
