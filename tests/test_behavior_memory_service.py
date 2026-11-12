"""文件职责：行为记忆用例层（services/behavior_memory_service.py）的行为测试（T2.1c）。

依赖方向：tests -> services.behavior_memory_service / core.memory / core.usage / config；
记忆库与统计都注入假实现，不碰 SQLCipher、不碰 usage.db 文件。
测试重点：三条推导规则的阈值与档位、refresh 的写入与陈旧清理、开关关闭时清空、
schedule 的节流与去重、以及「统计读不到 / 记忆库写不进」时全程不抛异常。
谁调用：pytest。
"""

import asyncio
from dataclasses import replace

import pytest

from config import MemorySettings
from contracts.errors import CODE_MEM_INDEX_BROKEN
from core.errors import MemoryStoreError
from core.memory import MemoryDraft, MemoryQuery, MemoryRecord
from core.usage import BehaviorStats, CharacterUsage
from services.behavior_memory_service import (
    ACTION_KIND,
    ACTION_SOURCE,
    BehaviorMemoryService,
    build_behavior_memory_service,
    derive_observations,
    hour_block,
)

CHAR = "amber"
OTHER = "nova"
NOW = 1_700_000_000.0


def _record(memory_id: int, text: str) -> MemoryRecord:
    return MemoryRecord(
        memory_id=memory_id,
        char_id=CHAR,
        kind=ACTION_KIND,
        tier="fact",
        text=text,
        importance=0.4,
        created_at=NOW,
        last_used_at=None,
        used_count=0,
        source_msg_ids="",
    )


def _stats(
    *,
    char_sessions: int = 0,
    char_interrupts: int = 0,
    char_shakes: int = 0,
    char_hits: int = 0,
    hit_regions: int = 0,
    gesture_counts: tuple[tuple[str, int], ...] = (),
    total_sessions: int = 0,
    start_hours: tuple[int, ...] = (),
    characters: tuple[CharacterUsage, ...] = (),
) -> BehaviorStats:
    return BehaviorStats(
        char_id=CHAR,
        char_sessions=char_sessions,
        char_interrupts=char_interrupts,
        char_shakes=char_shakes,
        char_hits=char_hits,
        hit_regions=hit_regions,
        gesture_counts=gesture_counts,
        total_sessions=total_sessions,
        start_hours=start_hours,
        characters=characters,
    )


class FakeMemory:
    """假记忆服务：只实现行为记忆用到的那三个方法，并记下被调用顺序。"""

    def __init__(
        self,
        rows: tuple[MemoryRecord, ...] = (),
        *,
        list_error: MemoryStoreError | None = None,
        write_error: MemoryStoreError | None = None,
    ) -> None:
        self.rows = list(rows)
        self.list_error = list_error
        self.write_error = write_error
        self.queries: list[MemoryQuery] = []
        self.recorded: list[tuple[str, str, list[MemoryDraft], float]] = []
        self.deleted: list[int] = []

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        self.queries.append(query)
        if self.list_error is not None:
            raise self.list_error
        return [row for row in self.rows if query.kind == "" or row.kind == query.kind]

    def record_facts(
        self, *, char_id: str, session_id: str, facts: list[MemoryDraft], ts: float
    ) -> list[int]:
        if self.write_error is not None:
            raise self.write_error
        self.recorded.append((char_id, session_id, list(facts), ts))
        return [100 + index for index in range(len(facts))]

    def delete(self, memory_id: int) -> bool:
        self.deleted.append(memory_id)
        return True


class FakeReader:
    """假统计读取器：要么给出固定统计，要么按需求抛异常。"""

    def __init__(
        self, stats: BehaviorStats | None = None, *, error: Exception | None = None
    ) -> None:
        self.stats = stats or BehaviorStats(char_id=CHAR)
        self.error = error
        self.calls = 0

    def behavior_stats(self, char_id: str) -> BehaviorStats:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.stats


def _service(
    memory: FakeMemory | None = None,
    reader: FakeReader | None = None,
    *,
    behavior_enabled: bool = True,
    interval_s: float = 3600.0,
) -> BehaviorMemoryService:
    settings = replace(MemorySettings(), behavior_enabled=behavior_enabled)
    return BehaviorMemoryService(
        memory or FakeMemory(),
        reader or FakeReader(),
        settings,
        now=lambda: NOW,
        interval_s=interval_s,
    )


# ---------------------------------------------------------------- 时段分块


@pytest.mark.parametrize(
    ("hour", "expected"),
    [
        (0, "深夜"),
        (4, "深夜"),
        (5, "早上"),
        (8, "早上"),
        (9, "上午"),
        (11, "上午"),
        (12, "中午"),
        (13, "中午"),
        (14, "下午"),
        (17, "下午"),
        (18, "晚上"),
        (22, "晚上"),
        (23, "深夜"),
    ],
)
def test_hour_block_boundaries(hour: int, expected: str) -> None:
    """分段边界必须与常量表一致：错一小时会把「熬夜」说成「早起」。"""
    assert hour_block(hour) == expected


# ---------------------------------------------------------------- 三条规则


def test_no_observation_without_enough_sessions() -> None:
    """样本不够时不下任何结论（宁可少说，也不要把两三次偶发当成习惯）。"""
    stats = _stats(char_sessions=2, char_interrupts=2, total_sessions=2, start_hours=(23, 23))
    assert derive_observations(stats) == []


@pytest.mark.parametrize(
    ("sessions", "interrupts", "fragment"),
    [
        # 打断次数必须过 MIN_INTERRUPTS(=3)，否则样本再足也不下结论；
        # 档位看 打断次数/会话次数：0.4 → 经常，0.2 → 偶尔，0.1 → 很少
        (10, 4, "经常"),
        (20, 4, "偶尔"),
        (30, 3, "很少"),
    ],
)
def test_interrupt_observation_bands(sessions: int, interrupts: int, fragment: str) -> None:
    drafts = derive_observations(_stats(char_sessions=sessions, char_interrupts=interrupts))
    assert len(drafts) == 1
    assert fragment in drafts[0].text
    assert drafts[0].kind == ACTION_KIND and drafts[0].source == ACTION_SOURCE


@pytest.mark.parametrize(
    ("sessions", "shakes", "fragment"),
    [
        # 与打断同门槛：MIN_SHAKES(=3) 必须过，档位看 晃动次数/会话次数
        (10, 4, "晃得还挺起劲"),
        (20, 4, "偶尔会晃"),
        (30, 3, "很少晃"),
    ],
)
def test_shake_observation_bands(sessions: int, shakes: int, fragment: str) -> None:
    drafts = derive_observations(_stats(char_sessions=sessions, char_shakes=shakes))
    assert len(drafts) == 1
    assert fragment in drafts[0].text
    assert drafts[0].kind == ACTION_KIND and drafts[0].source == ACTION_SOURCE


def test_shake_observation_needs_samples() -> None:
    """晃得太少或样本不够都不下结论：偶尔动一下不算习惯。"""
    assert derive_observations(_stats(char_sessions=10, char_shakes=2)) == []
    assert derive_observations(_stats(char_sessions=2, char_shakes=9)) == []


def test_hour_observation_uses_dominant_block() -> None:
    stats = _stats(total_sessions=6, start_hours=(23, 23, 23, 0, 1, 2))
    drafts = derive_observations(stats)
    assert [draft.text for draft in drafts] == ["他多半在深夜的时候来找你说话。"]


def test_hour_observation_skips_split_schedule() -> None:
    """一天里每个时段都来一次 = 没有主时段，这种时候不说比说错好。"""
    stats = _stats(total_sessions=6, start_hours=(1, 6, 10, 13, 16, 20))
    assert derive_observations(stats) == []


def test_preference_observation_when_ranked_first() -> None:
    stats = _stats(
        char_sessions=3,
        characters=(
            CharacterUsage(char_id=CHAR, total_duration_sec=900.0, session_count=3),
            CharacterUsage(char_id=OTHER, total_duration_sec=60.0, session_count=1),
        ),
    )
    drafts = derive_observations(stats)
    assert [draft.text for draft in drafts] == ["他找你的次数比别的角色多，你算是他常点的那个。"]


def test_preference_observation_when_not_first() -> None:
    stats = _stats(
        char_sessions=3,
        characters=(
            CharacterUsage(char_id=OTHER, total_duration_sec=900.0, session_count=3),
            CharacterUsage(char_id=CHAR, total_duration_sec=60.0, session_count=3),
        ),
    )
    drafts = derive_observations(stats)
    assert drafts[0].text == "他偶尔来找你，平时也会去别的角色那边。"


def test_single_character_never_gets_preference_observation() -> None:
    """只有一个角色时「最常用」是废话，没有比较就没有偏好。"""
    stats = _stats(
        char_sessions=5,
        characters=(CharacterUsage(char_id=CHAR, total_duration_sec=900.0, session_count=5),),
    )
    assert derive_observations(stats) == []


# ---------------------------------------------------------------- refresh


def test_refresh_writes_observations_and_drops_stale_rows() -> None:
    stale = _record(7, "他很少打断你，基本上会先听你把话说完。")
    keep = _record(9, "他经常在你话说到一半的时候打断你，你已经被他抢话抢习惯了。")
    memory = FakeMemory((stale, keep))
    service = _service(memory, FakeReader(_stats(char_sessions=10, char_interrupts=4)))

    ids = service.refresh(CHAR)

    assert ids == [100]
    assert memory.deleted == [7], "文本不匹配的旧观察要删掉"
    assert memory.recorded[0][0] == CHAR
    assert memory.recorded[0][1] == ""
    assert memory.recorded[0][3] == NOW
    assert memory.queries[0].kind == ACTION_KIND, "只认领自己的 kind=action 条目"


def test_refresh_clears_everything_when_disabled() -> None:
    memory = FakeMemory((_record(3, "他很少打断你，基本上会先听你把话说完。"),))
    reader = FakeReader()
    service = _service(memory, reader, behavior_enabled=False)

    assert service.enabled is False
    assert service.refresh(CHAR) == []
    assert memory.deleted == [3]
    assert memory.recorded == []
    assert reader.calls == 0, "开关关掉就不该再读统计"


def test_refresh_skips_when_store_unavailable() -> None:
    memory = FakeMemory(list_error=MemoryStoreError(CODE_MEM_INDEX_BROKEN, "库不可用"))
    service = _service(memory)
    assert service.refresh(CHAR) == []


def test_refresh_survives_stats_failure() -> None:
    memory = FakeMemory()
    reader = FakeReader(error=OSError("usage.db 读不动"))
    service = _service(memory, reader)

    assert service.refresh(CHAR) == []
    assert memory.recorded == [], "统计失败就不要凭空写观察"


def test_refresh_ignores_empty_char_id() -> None:
    memory = FakeMemory()
    service = _service(memory)
    assert service.refresh("") == []
    assert memory.queries == []


# ---------------------------------------------------------------- schedule


def test_schedule_without_event_loop_is_a_no_op() -> None:
    """组合根或单测在同步上下文里误调时不能炸。"""
    reader = FakeReader(_stats(char_sessions=10, char_interrupts=1))
    service = _service(FakeMemory(), reader)
    service.schedule(CHAR)
    assert reader.calls == 0


async def test_schedule_runs_in_background_and_throttles() -> None:
    reader = FakeReader(_stats(char_sessions=10, char_interrupts=1))
    memory = FakeMemory()
    service = _service(memory, reader)

    service.schedule(CHAR)
    await asyncio.sleep(0.05)
    assert reader.calls == 1
    assert memory.recorded, "后台任务真的写了观察"

    service.schedule(CHAR)
    await asyncio.sleep(0.05)
    assert reader.calls == 1, "同一角色在间隔内只刷一次"


async def test_schedule_deduplicates_while_running() -> None:
    """上一轮还没跑完时再排一次也不能并发出两个任务（_running 集合）。"""
    reader = FakeReader(_stats(char_sessions=10, char_interrupts=1))
    service = _service(FakeMemory(), reader, interval_s=0.0)

    service.schedule(CHAR)
    service.schedule(CHAR)
    await asyncio.sleep(0.05)
    assert reader.calls == 1


# ---------------------------------------------------------------- 组合根


def test_builder_uses_settings_memory_section() -> None:
    """组合根只传 settings 与记忆服务：开关来自 MemorySettings，库路径来自 usage_db_file。"""
    settings = replace(MemorySettings(), behavior_enabled=False)
    built = build_behavior_memory_service(_settings_from(settings), FakeMemory())
    assert built.enabled is False


def _settings_from(memory: MemorySettings):
    """只给 build_behavior_memory_service 用得上的字段：memory 段（库路径走 data_dir 属性）。"""
    from config import Settings

    return replace(Settings(), memory=memory)


def test_hit_observation_needs_samples_and_scales_with_ratio() -> None:
    """触摸规则（T2.3-C2c）：样本不足不下结论，比例分三档，手势与多部位各加一句。"""
    assert derive_observations(_stats(char_sessions=5, char_hits=4)) == []

    often = derive_observations(
        _stats(
            char_sessions=3,
            char_hits=30,
            hit_regions=3,
            gesture_counts=(("knead", 12), ("tap", 3)),
        )
    )
    assert [draft.text for draft in often] == [
        "他老对你动手，手闲不下来，最爱揉你，还专挑不同部位下手。"
    ]
    assert often[0].kind == ACTION_KIND
    assert often[0].source == ACTION_SOURCE

    sometimes = derive_observations(_stats(char_sessions=3, char_hits=12))
    assert [draft.text for draft in sometimes] == ["他偶尔会摸一下你的立绘，图个反应。"]

    rarely = derive_observations(_stats(char_sessions=10, char_hits=10))
    assert [draft.text for draft in rarely] == ["他很少动手点你，多数时候只是看着。"]
