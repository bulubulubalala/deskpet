"""文件职责：拟人化时间金字塔的生成侧（T2.33）。

Episode（会话片段）→ Day（自然日）→ Week（自然周）→ Month（自然月）。
只从下一层生成上一层，所有失败只记日志；时间线是增强项，绝不阻塞对话。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Callable, Iterable, Sequence
from datetime import date, datetime, timedelta
from datetime import time as clock_time

from adapters.llm_openai import LlmEndpoint, OpenAiChatClient
from config import LlmSettings, MemorySettings, Settings
from core.logging import get_logger, log_event
from core.memory import (
    DiaryEntry,
    MemoryBackendError,
    MemoryPeriod,
    MemoryStore,
    MessageRow,
    truncate_to_tokens,
)
from core.prompt import wrap_untrusted
from services.llm_ports import ClientFactory

LOGGER = get_logger("services.memory_timeline_service")


MAX_OUTPUT_CHARS = 4000
MIN_OUTPUT_TOKENS = 40
EPISODE_GAP_S = 30 * 60.0
LOOKBACK_DAYS = 3

_SYSTEM_EPISODE = (
    "你是角色记忆整理器。把下面这段对话整理成一段情景记忆："
    "发生了什么、用户当时的状态与情绪、双方做了什么、还有什么没完成。"
    "只写原文里有依据的内容，不要评价，不要编造。用 1–3 句中文，直接输出正文。"
)
_SYSTEM_DAY = (
    "你是角色记忆整理器。把下面几段情景记忆整理成一篇简短日记，按时间顺序写。"
    "保留具体事件、用户情绪、关系变化和未完成的事；合并重复内容，不要新增原文没有的信息。"
    "用第一人称写，像角色自己在回忆这一天。直接输出正文，不要标题。"
)
_SYSTEM_WEEK = (
    "你是角色记忆整理器。把下面几天的日记整理成这一周的回忆。"
    "保留反复出现的人、事、情绪与未解决的话题，不要逐日流水账。"
    "用第一人称写，直接输出正文，不要标题。"
)
_SYSTEM_MONTH = (
    "你是角色记忆整理器。把下面几周的回忆整理成这个月的长期记忆。"
    "保留关系变化、重要事件、反复出现的偏好与仍未解决的事；不要编造。"
    "用第一人称写，直接输出正文，不要标题。"
)


class MemoryTimelineService:
    """把消息 / 下层时间桶整理成 Episode、Day、Week、Month。"""

    def __init__(
        self,
        store: MemoryStore | None,
        settings: MemorySettings,
        *,
        llm: LlmSettings,
        client_factory: ClientFactory | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._llm = llm
        self._client_factory = client_factory or self._build_client
        self._now = now or time.time
        self._running: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def available(self) -> bool:
        return bool(self._store is not None and self._settings.timeline_enabled)

    def _build_client(self, endpoint: LlmEndpoint) -> OpenAiChatClient:
        return OpenAiChatClient(endpoint, timeout_s=self._llm.total_timeout_s)

    def schedule(self, char_id: str) -> None:
        if not self.available or not char_id or char_id in self._running:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._running.add(char_id)
        task = loop.create_task(self._guarded(char_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def run_forever(self) -> None:
        """夜间/空闲巩固：每隔一段时间把有记忆的角色都整理一遍。"""
        while True:
            if self.available and self._store is not None:
                lister = getattr(self._store, "list_character_ids", None)
                if callable(lister):
                    try:
                        chars = lister()
                    except Exception as exc:
                        log_event(
                            LOGGER,
                            logging.WARNING,
                            module="services.memory_timeline_service",
                            event="memory.timeline_failed",
                            message="夜间巩固读角色列表失败",
                            fields={"error": str(exc)},
                        )
                        chars = []
                    for char_id in chars:
                        if char_id in self._running:
                            continue
                        self._running.add(char_id)
                        try:
                            await self.consolidate(char_id)
                        except Exception:
                            pass
                        finally:
                            self._running.discard(char_id)
            await asyncio.sleep(max(300.0, self._settings.timeline_interval_s))

    async def _guarded(self, char_id: str) -> None:
        try:
            await self.consolidate(char_id)
        finally:
            self._running.discard(char_id)

    async def consolidate(self, char_id: str, *, now: float | None = None) -> dict[str, int]:
        """整理一批；返回各层新建/更新的条数。"""
        if not self.available:
            return {}
        moment = float(now or self._now())
        created = {"episode": 0, "day": 0, "week": 0, "month": 0}
        try:
            created["episode"] = await self._episodes(char_id, moment)
            created["day"] = await self._days(char_id, moment)
            created["week"] = await self._weeks(char_id, moment)
            created["month"] = await self._months(char_id, moment)
        except MemoryBackendError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_timeline_service",
                event="memory.timeline_failed",
                message="时间线整理写库失败，这一批不做",
                fields={"char_id": char_id, "reason": type(exc).__name__, "error": str(exc)},
            )
            return created
        except Exception as exc:  # 兜底：后台任务不能把异常抛回对话链路
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_timeline_service",
                event="memory.timeline_failed",
                message="时间线整理意外失败，这一批不做",
                fields={"char_id": char_id, "reason": type(exc).__name__, "error": str(exc)},
            )
            return created
        if any(created.values()):
            log_event(
                LOGGER,
                logging.INFO,
                module="services.memory_timeline_service",
                event="memory.timeline_consolidated",
                message="时间线整理完成",
                fields={"char_id": char_id, **created},
            )
        return created

    # ------------------------------------------------------------------ Episode

    async def _episodes(self, char_id: str, now: float) -> int:
        store = self._store
        if store is None or self._settings.l1_budget_tokens <= 0:
            return 0
        window_start = now - LOOKBACK_DAYS * 86400.0
        recent = store.list_periods(char_id, levels=("episode",), limit=1)
        start = window_start
        if recent:
            start = max(window_start, recent[0].period_end)
        return await self._episodes_between(char_id, start=start, end=now + 1.0, now=now)

    async def _episodes_between(self, char_id: str, *, start: float, end: float, now: float) -> int:
        store = self._store
        if store is None or self._settings.l1_budget_tokens <= 0:
            return 0
        rows = store.messages_between(char_id, start=start, end=end)
        if not rows:
            return 0
        created = 0
        for group in _group_messages(rows):
            if len(group) < 2:
                continue
            first, last = group[0], group[-1]
            source_hash = _hash_texts([f"{row.message_id}:{row.text}" for row in group])
            if _period_current(store, char_id, "episode", first.ts, source_hash):
                continue
            text = await self._complete(
                _SYSTEM_EPISODE,
                _render_messages(group),
                target_tokens=max(80, self._settings.l1_budget_tokens),
            )
            if not text:
                continue
            store.upsert_period(
                char_id=char_id,
                level="episode",
                period_start=first.ts,
                period_end=last.ts + 1.0,
                summary=text,
                label=_local_time_label(first.ts),
                day_key=_local_date(first.ts).isoformat(),
                source_hash=source_hash,
                model_id=self._model_id(),
                sources=[("message", row.message_id) for row in group],
                now=now,
            )
            created += 1
        return created

    async def backfill(
        self, char_id: str, *, days: int = 180, now: float | None = None
    ) -> dict[str, int]:
        """把历史原文按 7 天一段补成 Episode，再生成 Day/Week/Month。"""
        store = self._store
        if store is None:
            return {}
        moment = float(now or self._now())
        oldest = getattr(store, "oldest_message_ts", None)
        if not callable(oldest):
            return {}
        first = oldest(char_id)
        if first <= 0:
            return {}
        start = max(first, moment - max(1, days) * 86400.0)
        episodes = 0
        while start < moment:
            end = min(moment + 1.0, start + 7 * 86400.0)
            episodes += await self._episodes_between(char_id, start=start, end=end, now=moment)
            start = end
        created = await self.consolidate(char_id, now=moment)
        created["episode"] = created.get("episode", 0) + episodes
        return created

    # ------------------------------------------------------------------ Day

    async def _days(self, char_id: str, now: float) -> int:
        store = self._store
        if store is None or self._settings.timeline_budget_tokens <= 0:
            return 0
        episodes = store.list_periods(
            char_id,
            levels=("episode",),
            limit=500,
        )
        diary = store.list_diary(char_id, limit=200)
        grouped: dict[str, list[MemoryPeriod]] = {}
        for episode in episodes:
            key = episode.day_key or _local_date(episode.period_start).isoformat()
            grouped.setdefault(key, []).append(episode)
        diary_grouped: dict[str, list[DiaryEntry]] = {}
        for entry in diary:
            key = _local_date(entry.occurred_at).isoformat()
            diary_grouped.setdefault(key, []).append(entry)
        if not grouped and not diary_grouped:
            return 0
        created = 0
        for day_key in sorted(set(grouped) | set(diary_grouped)):
            items = sorted(grouped.get(day_key, []), key=lambda item: item.period_start)
            entries = sorted(diary_grouped.get(day_key, []), key=lambda item: item.occurred_at)
            day = date.fromisoformat(day_key)
            start, end = _day_bounds_for_date(day)
            source_hash = _hash_texts(
                [f"{item.period_id}:{item.summary}" for item in items]
                + [f"d{entry.entry_id}:{entry.text}" for entry in entries]
            )
            if _period_current(store, char_id, "day", start, source_hash):
                continue
            text = await self._complete(
                _SYSTEM_DAY,
                _render_day(items, entries),
                target_tokens=self._settings.timeline_budget_tokens,
            )
            if not text:
                continue
            store.upsert_period(
                char_id=char_id,
                level="day",
                period_start=start,
                period_end=end,
                summary=text,
                label=day_key,
                day_key=day_key,
                source_hash=source_hash,
                model_id=self._model_id(),
                sources=[("period", item.period_id) for item in items]
                + [("diary", entry.entry_id) for entry in entries],
                now=now,
            )
            created += 1
        return created

    # ------------------------------------------------------------------ Week / Month

    async def _weeks(self, char_id: str, now: float) -> int:
        store = self._store
        if store is None or self._settings.timeline_budget_tokens <= 0:
            return 0
        days = store.list_periods(
            char_id,
            levels=("day",),
            limit=500,
        )
        if not days:
            return 0
        grouped: dict[tuple[int, int], list[MemoryPeriod]] = {}
        for day_period in days:
            iso = _local_date(day_period.period_start).isocalendar()
            grouped.setdefault((iso.year, iso.week), []).append(day_period)
        created = 0
        for (year, week), items in grouped.items():
            items.sort(key=lambda item: item.period_start)
            start, end = _week_bounds(year, week)
            source_hash = _hash_texts([f"{item.period_id}:{item.summary}" for item in items])
            if _period_current(store, char_id, "week", start, source_hash):
                continue
            text = await self._complete(
                _SYSTEM_WEEK,
                _render_periods(items),
                target_tokens=self._settings.timeline_budget_tokens,
            )
            if not text:
                continue
            label = f"{year}-W{week:02d}"
            store.upsert_period(
                char_id=char_id,
                level="week",
                period_start=start,
                period_end=end,
                summary=text,
                label=label,
                day_key=label,
                source_hash=source_hash,
                model_id=self._model_id(),
                sources=[("period", item.period_id) for item in items],
                now=now,
            )
            created += 1
        return created

    async def _months(self, char_id: str, now: float) -> int:
        store = self._store
        if store is None or self._settings.timeline_budget_tokens <= 0:
            return 0
        weeks = store.list_periods(
            char_id,
            levels=("week",),
            limit=120,
        )
        if not weeks:
            return 0
        grouped: dict[str, list[MemoryPeriod]] = {}
        for week in weeks:
            grouped.setdefault(_local_date(week.period_start).strftime("%Y-%m"), []).append(week)
        created = 0
        for label, items in grouped.items():
            items.sort(key=lambda item: item.period_start)
            year, month = (int(part) for part in label.split("-"))
            start, end = _month_bounds(year, month)
            source_hash = _hash_texts([f"{item.period_id}:{item.summary}" for item in items])
            if _period_current(store, char_id, "month", start, source_hash):
                continue
            text = await self._complete(
                _SYSTEM_MONTH,
                _render_periods(items),
                target_tokens=self._settings.timeline_budget_tokens,
            )
            if not text:
                continue
            store.upsert_period(
                char_id=char_id,
                level="month",
                period_start=start,
                period_end=end,
                summary=text,
                label=label,
                day_key=label,
                source_hash=source_hash,
                model_id=self._model_id(),
                sources=[("period", item.period_id) for item in items],
                now=now,
            )
            created += 1
        return created

    # ------------------------------------------------------------------ 模型调用

    async def _complete(self, system: str, user: str, *, target_tokens: int) -> str:
        specs = self._llm.endpoint_specs()
        if not specs:
            return ""
        url, api_key, model, label = specs[0]
        client = self._client_factory(
            LlmEndpoint(
                base_url=url,
                api_key=api_key,
                model=model,
                preset=getattr(self._llm, "preset", ""),
            )
        )
        chunks: list[str] = []
        total = 0
        try:
            async for delta in client.stream_chat(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ]
            ):
                chunks.append(delta)
                total += len(delta)
                if total >= MAX_OUTPUT_CHARS:
                    break
        except Exception as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_timeline_service",
                event="memory.timeline_failed",
                message="时间线摘要生成失败，这一批不写",
                fields={"provider": label, "reason": type(exc).__name__, "error": str(exc)},
            )
            return ""
        text = "".join(chunks).strip()
        if not text:
            return ""
        return truncate_to_tokens(text, max(MIN_OUTPUT_TOKENS, target_tokens * 2))

    def _model_id(self) -> str:
        specs = self._llm.endpoint_specs()
        return specs[0][2] if specs else ""


def _period_current(
    store: MemoryStore, char_id: str, level: str, start: float, source_hash: str
) -> bool:
    """同一时间桶已有相同来源指纹（或用户手改过）时不重复调用模型。"""
    existing = store.list_periods(char_id, levels=(level,), since=start, until=start + 1.0, limit=1)
    if not existing or existing[0].period_start != start:
        return False
    return existing[0].edited_at > 0 or existing[0].source_hash == source_hash


def _group_messages(rows: Sequence[MessageRow]) -> list[list[MessageRow]]:
    groups: list[list[MessageRow]] = []
    current: list[MessageRow] = []
    for row in rows:
        if current and (
            row.session_id != current[-1].session_id or row.ts - current[-1].ts > EPISODE_GAP_S
        ):
            groups.append(current)
            current = []
        current.append(row)
    if current:
        groups.append(current)
    return groups


def _render_messages(rows: Sequence[MessageRow]) -> str:
    lines = [("我：" if row.role == "assistant" else "用户：") + row.text for row in rows]
    return "把下面这段对话整理成情景记忆：\n" + wrap_untrusted(
        "\n".join(lines), what="一段过往对话的原文"
    )


def _render_day(rows: Sequence[MemoryPeriod], entries: Sequence[DiaryEntry]) -> str:
    parts: list[str] = []
    if rows:
        parts.append("情景记忆：\n" + "\n".join("- " + row.summary for row in rows))
    if entries:
        parts.append("用户自己写的日记：\n" + "\n".join("- " + row.text for row in entries))
    return "把下面内容整理成今天的日记：\n" + wrap_untrusted(
        "\n".join(parts), what="今天的情景记忆与用户日记"
    )


def _render_periods(rows: Sequence[MemoryPeriod]) -> str:
    body = "\n".join("- " + row.summary for row in rows)
    return "把下面这些记忆整理成更上层的回忆：\n" + wrap_untrusted(
        body, what="之前生成的时间线记忆"
    )


def _hash_texts(values: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for value in values:
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _local_date(ts: float) -> date:
    return datetime.fromtimestamp(ts).astimezone().date()


def _local_time_label(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().strftime("%H:%M")


def _day_start(day: date) -> float:
    return datetime.combine(day, clock_time.min).astimezone().timestamp()


def _day_bounds_for_date(day: date) -> tuple[float, float]:
    return _day_start(day), _day_start(day + timedelta(days=1))


def _week_bounds(year: int, week: int) -> tuple[float, float]:
    monday = date.fromisocalendar(year, week, 1)
    return _day_start(monday), _day_start(monday + timedelta(days=7))


def _month_bounds(year: int, month: int) -> tuple[float, float]:
    start = date(year, month, 1)
    next_month = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    return _day_start(start), _day_start(next_month)


def build_memory_timeline_service(
    settings: Settings, store: MemoryStore | None
) -> MemoryTimelineService:
    return MemoryTimelineService(
        store,
        settings.memory,
        llm=settings.llm,
    )
