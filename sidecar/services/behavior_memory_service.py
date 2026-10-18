"""文件职责：行为记忆（F3 / T2.1c）——把 usage.db 的计数归纳成「你对他的观察」。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：ChatService 每轮收尾后 fire-and-forget（schedule）；组合根用
build_behavior_memory_service 构造；测试直接调 refresh() 即可。

四条规则（零埋点，只用 T1.9 与 T2.3 已经记下的计数）：
- 打断：他在你说话时打断你的频率；
- 时段：他大多在一天里的哪一段来找你；
- 偏好：他是不是常来找你这个角色（与其他角色的累计时长比）；
- 晃动：他着急或者无聊时甩你窗口的频率（T2.3-C1）。

约定：
- 只有 kind=action、source=action 的条目由这里写；文本用**稳定粗档**（不写具体次数），
  免得每刷新一次文本就变一次，把去重键撞出一串近似行；证据始终留在 usage.db。
- 观察是「我们按计数归纳的」，不是用户说过的话：提示词里单独成段、不裹 untrusted。
- 全程吞失败：usage.db 读不到、记忆库写不进都只记日志——它是增强项，绝不能影响对话。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from collections.abc import Callable, Sequence

from adapters.usage_sqlite import UsageStatsReader
from config import MemorySettings, Settings
from core.errors import MemoryStoreError
from core.logging import get_logger, log_event
from core.memory import (
    ACTION_KIND,
    ACTION_SOURCE,
    MAX_LIST_LIMIT,
    MemoryDraft,
    MemoryQuery,
    MemoryRecord,
    normalize_memory_text,
)
from core.usage import BehaviorStats, BehaviorStatsReader
from services.memory_service import MemoryService

LOGGER = get_logger("services.behavior_memory_service")

#: 写进 memories 表的 kind / source 定义在 core.memory（memory_service 也要用它挡编辑，
#: 放这里会形成 services 内部循环依赖）；清理陈旧条目时靠它们认领自己写的行
#: 观察里不带会话 id（它不属于任何一轮对话）
ACTION_SESSION_ID = ""
#: 同一个角色最多一小时刷新一次（对话收尾时触发，节流交给这里）
DEFAULT_OBSERVATION_INTERVAL_S = 3600.0

#: 打断规则：至少这么多次会话与这么多次打断才下结论
MIN_SESSIONS_FOR_INTERRUPTS = 3
MIN_INTERRUPTS = 3
#: 打断率分档（次/会话）
INTERRUPT_RATIO_OFTEN = 0.35
INTERRUPT_RATIO_SOMETIMES = 0.15
#: 晃动规则：样本门槛与打断一致，分档也照搬（晃动是比抢话更强的情绪信号）
MIN_SHAKES = 3
SHAKE_RATIO_OFTEN = 0.35
SHAKE_RATIO_SOMETIMES = 0.15
#: 时段规则：全局至少这么多次会话、这么多个样本，主时段占比要过线
MIN_SESSIONS_FOR_HOURS = 5
MIN_HOUR_SAMPLES = 3
HOUR_SHARE_THRESHOLD = 0.4
#: 偏好规则：至少两个角色参与统计，本角色至少这么多次会话
MIN_CHARACTERS_FOR_PREFERENCE = 2
MIN_SESSIONS_FOR_PREFERENCE = 3
#: 部位点击规则（T2.3-C2b）：样本门槛同晃动，比例按「点了多少下 / 会话数」分档
MIN_HITS = 5
HIT_RATIO_OFTEN = 8.0
HIT_RATIO_SOMETIMES = 3.0
#: 点过多少种不同部位才算「专挑不同部位下手」
HIT_REGIONS_FOR_VARIETY = 3

#: 一天的分段（左闭右开，按本地小时）；相邻同名段会合并计数
_HOUR_BLOCKS: tuple[tuple[int, int, str], ...] = (
    (0, 5, "深夜"),
    (5, 9, "早上"),
    (9, 12, "上午"),
    (12, 14, "中午"),
    (14, 18, "下午"),
    (18, 23, "晚上"),
    (23, 24, "深夜"),
)


def hour_block(hour: int) -> str:
    """把 0–23 的小时映射成时段名（越界值按 0 处理，宁可归到深夜也不抛错）。"""
    for start, end, name in _HOUR_BLOCKS:
        if start <= hour < end:
            return name
    return "深夜"


def derive_observations(stats: BehaviorStats) -> list[MemoryDraft]:
    """按三条规则把计数归纳成观察条目（纯函数，便于单测与回放）。"""
    drafts: list[MemoryDraft] = []
    drafts.extend(_interrupt_observation(stats))
    drafts.extend(_shake_observation(stats))
    drafts.extend(_hit_observation(stats))
    drafts.extend(_hour_observation(stats))
    drafts.extend(_character_observation(stats))
    return drafts


def _interrupt_observation(stats: BehaviorStats) -> list[MemoryDraft]:
    """他打断你的频率：样本太少就不下结论。"""
    if stats.char_sessions < MIN_SESSIONS_FOR_INTERRUPTS:
        return []
    if stats.char_interrupts < MIN_INTERRUPTS:
        return []
    ratio = stats.char_interrupts / stats.char_sessions
    if ratio >= INTERRUPT_RATIO_OFTEN:
        text = "他经常在你话说到一半的时候打断你，你已经被他抢话抢习惯了。"
        importance = 0.45
    elif ratio >= INTERRUPT_RATIO_SOMETIMES:
        text = "他偶尔会在你话说到一半的时候打断你。"
        importance = 0.40
    else:
        text = "他很少打断你，基本上会先听你把话说完。"
        importance = 0.35
    return [_observation(stats.char_id, text, importance)]


def _shake_observation(stats: BehaviorStats) -> list[MemoryDraft]:
    """他晃你窗口的频率：晃动比说话更情绪化，样本不够就不下结论。"""
    if stats.char_sessions < MIN_SESSIONS_FOR_INTERRUPTS:
        return []
    if stats.char_shakes < MIN_SHAKES:
        return []
    ratio = stats.char_shakes / stats.char_sessions
    if ratio >= SHAKE_RATIO_OFTEN:
        text = "他着急或者无聊的时候会晃你的窗口，晃得还挺起劲。"
        importance = 0.45
    elif ratio >= SHAKE_RATIO_SOMETIMES:
        text = "他偶尔会晃一下你的窗口。"
        importance = 0.40
    else:
        text = "他很少晃你的窗口，多数时候只是安安静静待在旁边。"
        importance = 0.35
    return [_observation(stats.char_id, text, importance)]


def _hit_observation(stats: BehaviorStats) -> list[MemoryDraft]:
    """他点你立绘的频率：样本太少就不下结论。

    文案里不带部位名：usage.db 只存 region_id（英文 id），中文名在角色包里、用户可以自定义，
    按 id 拼中文等于把英文 id 念给用户听（T2.3-C2b 的取舍）。
    """
    if stats.char_sessions < MIN_SESSIONS_FOR_INTERRUPTS:
        return []
    if stats.char_hits < MIN_HITS:
        return []
    ratio = stats.char_hits / stats.char_sessions
    if ratio >= HIT_RATIO_OFTEN:
        text = "他老戳你的立绘，手闲不下来"
        if stats.hit_regions >= HIT_REGIONS_FOR_VARIETY:
            text += "，还专挑不同部位下手"
        text += "。"
        importance = 0.45
    elif ratio >= HIT_RATIO_SOMETIMES:
        text = "他偶尔会戳一下你的立绘，图个反应。"
        importance = 0.40
    else:
        text = "他很少动手点你，多数时候只是看着。"
        importance = 0.35
    return [_observation(stats.char_id, text, importance)]


def _hour_observation(stats: BehaviorStats) -> list[MemoryDraft]:
    """他多半什么时候来：主时段占比过线才说，否则当作「作息不固定」。"""
    if stats.total_sessions < MIN_SESSIONS_FOR_HOURS:
        return []
    if len(stats.start_hours) < MIN_HOUR_SAMPLES:
        return []
    counts = Counter(hour_block(hour) for hour in stats.start_hours)
    block, count = counts.most_common(1)[0]
    if count / len(stats.start_hours) < HOUR_SHARE_THRESHOLD:
        return []
    text = "他多半在" + block + "的时候来找你说话。"
    return [_observation(stats.char_id, text, 0.40)]


def _character_observation(stats: BehaviorStats) -> list[MemoryDraft]:
    """他是不是常来找你：只在有别的角色可比、且本角色样本够时下结论。"""
    if stats.char_sessions < MIN_SESSIONS_FOR_PREFERENCE:
        return []
    if len(stats.characters) < MIN_CHARACTERS_FOR_PREFERENCE:
        return []
    rank = next(
        (index for index, item in enumerate(stats.characters) if item.char_id == stats.char_id),
        None,
    )
    if rank is None:
        return []
    if rank == 0:
        text = "他找你的次数比别的角色多，你算是他常点的那个。"
        importance = 0.40
    else:
        text = "他偶尔来找你，平时也会去别的角色那边。"
        importance = 0.35
    return [_observation(stats.char_id, text, importance)]


def _observation(char_id: str, text: str, importance: float) -> MemoryDraft:
    """构造一条行为观察草稿（kind/source 固定，tier 走事实层）。"""
    return MemoryDraft(
        char_id=char_id,
        kind=ACTION_KIND,
        text=text,
        importance=importance,
        source=ACTION_SOURCE,
        tier="fact",
    )


class BehaviorMemoryService:
    """把用量计数归纳成观察并写进记忆库；同步 refresh + 后台 schedule（节流）。"""

    def __init__(
        self,
        memory: MemoryService,
        reader: BehaviorStatsReader,
        settings: MemorySettings,
        *,
        now: Callable[[], float] | None = None,
        interval_s: float = DEFAULT_OBSERVATION_INTERVAL_S,
    ) -> None:
        self._memory = memory
        self._reader = reader
        self._settings = settings
        self._now = now or time.time
        self._interval_s = interval_s
        self._last_run: dict[str, float] = {}
        self._running: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def enabled(self) -> bool:
        """行为记忆总开关（设置页写 .env，下次启动生效）。"""
        return bool(self._settings.behavior_enabled)

    def refresh(self, char_id: str) -> list[int]:
        """同步刷新一个角色的观察；返回写入 / 命中的记忆 id（不可用时安静跳过）。

        开关关掉时顺手清掉之前派生的条目：用户关的是「别记这些」，不是「别再新增」。
        """
        if not char_id:
            return []
        try:
            existing = self._memory.list_memories(
                MemoryQuery(char_id=char_id, kind=ACTION_KIND, limit=MAX_LIST_LIMIT)
            )
        except MemoryStoreError as exc:
            _log_skip(char_id, str(exc))
            return []
        if not self.enabled:
            self._drop(existing, keep=frozenset())
            return []
        try:
            stats = self._reader.behavior_stats(char_id)
        except Exception as exc:  # 统计读不到只是没有观察，不影响对话
            _log_failure(char_id, stage="stats", error=repr(exc))
            return []
        drafts = derive_observations(stats)
        self._drop(existing, keep=frozenset(normalize_memory_text(d.text) for d in drafts))
        ids = self._memory.record_facts(
            char_id=char_id,
            session_id=ACTION_SESSION_ID,
            facts=drafts,
            ts=self._now(),
        )
        log_event(
            LOGGER,
            logging.INFO,
            module="services.behavior_memory_service",
            event="behavior.refreshed",
            message="行为观察已刷新",
            fields={"char_id": char_id, "observations": len(drafts), "ids": ids},
        )
        return ids

    def schedule(self, char_id: str) -> None:
        """把一次刷新排到后台；没到间隔、已经在跑或没有事件循环都直接返回。"""
        if not char_id or char_id in self._running:
            return
        moment = self._now()
        if moment - self._last_run.get(char_id, 0.0) < self._interval_s:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._running.add(char_id)
        task = loop.create_task(self._guarded(char_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _guarded(self, char_id: str) -> None:
        """后台任务的外壳：跑在线程池里，任何异常都只记日志。"""
        try:
            await asyncio.to_thread(self.refresh, char_id)
        except Exception as exc:  # 后台任务没有调用方可以接住异常
            _log_failure(char_id, stage="refresh", error=repr(exc))
        finally:
            self._running.discard(char_id)
            self._last_run[char_id] = self._now()

    def _drop(self, existing: Sequence[MemoryRecord], *, keep: frozenset[str]) -> None:
        """删掉不在本次集合里的旧观察（文本变了或规则不再成立）。"""
        for row in existing:
            if normalize_memory_text(row.text) in keep:
                continue
            try:
                self._memory.delete(row.memory_id)
            except MemoryStoreError as exc:
                _log_failure(row.char_id, stage="delete", error=str(exc))


def _log_skip(char_id: str, error: str) -> None:
    """记忆库不可用：不是故障，跳过这一轮就行。"""
    log_event(
        LOGGER,
        logging.DEBUG,
        module="services.behavior_memory_service",
        event="behavior.skipped",
        message="记忆库不可用，跳过行为观察",
        fields={"char_id": char_id, "error": error},
    )


def _log_failure(char_id: str, *, stage: str, error: str) -> None:
    """读统计或写观察失败：记一条警告，绝不影响对话。"""
    log_event(
        LOGGER,
        logging.WARNING,
        module="services.behavior_memory_service",
        event="behavior.failed",
        message="行为观察刷新失败",
        fields={"char_id": char_id, "stage": stage, "error": error},
    )


def build_behavior_memory_service(
    settings: Settings,
    memory: MemoryService,
    *,
    reader: BehaviorStatsReader | None = None,
) -> BehaviorMemoryService:
    """按设置装配行为记忆：只读 usage.db，写 memories.db 的 action 条目（T2.1c）。"""
    return BehaviorMemoryService(
        memory,
        reader or UsageStatsReader(settings.usage_db_file),
        settings.memory,
    )
