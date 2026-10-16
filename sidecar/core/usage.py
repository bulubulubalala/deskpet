"""文件职责：使用统计（F10 / 需求 §6.9）的纯逻辑——会话账本、增量与元数据键名。

依赖方向：core 只依赖标准库（CODE_STYLE §1.1）；落盘在 adapters/usage_sqlite.py，
编排在 services/usage_service.py，本模块不认识 SQL 也不认识 HTTP。
谁调用：services/usage_service.py 持有 UsageSession；测试直接构造它验证累计语义。

三条容易踩的规则（§6.9）：
- **只记事实，不记内容**：这里存的是计数与时间戳，任何台词、屏幕文本都不进这张表；
- **char_usage / daily 是累加表**：会话过程中会多次 flush，所以每次只交接「自上次成功写入
  以来的增量」，写成功后才清空（drain），否则重试一次就多算一次；
- **写失败是 A 级错误**：调用方记日志后继续对话，绝不因为它打断聊天。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

#: meta 表的两个键（§6.9「记录开关、scheme_version」）
META_RECORDING_ENABLED = "recording_enabled"
META_SCHEME_VERSION = "scheme_version"
#: 表结构版本：以后加字段时靠它判断要不要迁移（v2 = T1.14 给 session 加三列 provider）
SCHEME_VERSION = "2"
#: 「暂停记录」在 meta 里的取值
RECORDING_ENABLED_VALUE = "1"
RECORDING_DISABLED_VALUE = "0"
#: 批量写：会话结束或每 5 分钟 flush 一次，不逐条消息写盘（§6.9）
DEFAULT_FLUSH_INTERVAL_S = 300.0
#: 超过这么久没有新消息就视为会话结束（下次 flush 时收尾并写入 ended_at）
DEFAULT_IDLE_TIMEOUT_S = 300.0


@dataclass(frozen=True, slots=True)
class ProviderNames:
    """启动时三个能力面的模型供给选择（§6.13 / D19）；写进 session 行的三列。"""

    llm: str = ""
    asr: str = ""
    tts: str = ""


@dataclass(frozen=True, slots=True)
class SessionRow:
    """session 表的一行；时间戳是 Unix 秒，duration_sec 是秒。

    三个 provider 列记「这一轮实际用的是哪套供给」（§6.13）：asr / tts 在建会话时定下，
    llm 在主用失败切备用后回填——使用历史无法回填，所以列必须先有。
    """

    session_id: str
    char_id: str
    started_at: float
    ended_at: float | None
    duration_sec: float
    msg_count: int
    interrupt_count: int
    voice_msg_count: int
    text_msg_count: int
    screen_capture_count: int
    llm_provider: str = ""
    asr_provider: str = ""
    tts_provider: str = ""


@dataclass(frozen=True, slots=True)
class CharacterUsage:
    """char_usage 表的一行：某个角色累计用了多久 / 开过几次会话。"""

    char_id: str
    total_duration_sec: float
    session_count: int


@dataclass(frozen=True, slots=True)
class BehaviorStats:
    """行为观察（T2.1c）需要的原始证据——全部来自 usage.db 的计数与时间戳。

    这里**没有任何对话内容**（§6.9 的「只记事实，不记内容」）：start_hours 是会话开始时
    的本地小时（0–23），characters 按累计时长降序排好，其余是当前角色的计数。
    """

    char_id: str
    char_sessions: int = 0
    char_interrupts: int = 0
    char_messages: int = 0
    total_sessions: int = 0
    start_hours: tuple[int, ...] = ()
    characters: tuple[CharacterUsage, ...] = ()


class BehaviorStatsReader(Protocol):
    """行为记忆服务的最小只读依赖（core 定义、adapters 实现，CODE_STYLE §1.4）。"""

    def behavior_stats(self, char_id: str) -> BehaviorStats:
        """汇总某个角色的行为计数；库还不存在时返回空统计而不是抛错。"""
        ...


@dataclass(frozen=True, slots=True)
class UsageDeltas:
    """自上次成功写入以来累积的增量（chars / daily 两张累加表用）。"""

    char_seconds: dict[str, float]
    char_sessions: dict[str, int]
    daily_seconds: float
    daily_msgs: int
    daily_sessions: int


class UsageStore(Protocol):
    """usage.db 的读写接口（core 定义、adapters 实现，CODE_STYLE §1.4）。"""

    def read_meta(self, key: str) -> str | None:
        """读一个 meta 值；键不存在返回 None。"""
        ...

    def write_meta(self, key: str, value: str) -> None:
        """写一个 meta 值（存在即覆盖）。"""
        ...

    def write_session(self, row: SessionRow) -> None:
        """整行写入 / 覆盖一个会话（绝对值，天然幂等）。"""
        ...

    def add_char_usage(self, char_id: str, *, seconds: float, sessions: int, at: float) -> None:
        """给某个角色的累计表加时长与会话次数。"""
        ...

    def add_daily(
        self, date: str, *, duration_sec: float, session_count: int, msg_count: int
    ) -> None:
        """给某一天的累计表加时长、会话次数与消息数。"""
        ...

    def append_switch(self, at: float, from_char_id: str | None, to_char_id: str) -> None:
        """追加一条角色切换记录（只追加，不改）。"""
        ...

    def clear_usage(self) -> None:
        """清空统计（保留 meta：记录开关与表结构版本）。"""
        ...

    def close(self) -> None:
        """关闭底层连接。"""
        ...


class UsageRecorder(Protocol):
    """上层（ChatService）需要的最小写入接口：只报事实，不关心落到哪张表。"""

    def record_turn(
        self, session_id: str, char_id: str, *, voice: bool, at: float | None = None
    ) -> None:
        """记一轮用户输入（会话不存在就自动开始一个）。"""
        ...

    def record_interrupt(self, session_id: str, *, at: float | None = None) -> None:
        """记一次打断。"""
        ...

    def record_provider(self, session_id: str, name: str) -> None:
        """记下本轮实际用上的 LLM 供给（§6.13；切过备用时覆盖启动时的配置值）。"""
        ...

    async def flush_if_due(self) -> bool:
        """攒够一个批量窗口就落盘；没到点直接返回 False（§6.9 的「每 5 分钟 flush」）。"""
        ...


def day_key(at: float) -> str:
    """时间戳 → 本地日期 YYYY-MM-DD。

    用本机时区而不是 UTC：用户看的「今天聊了多久」是本机的今天。
    """
    return datetime.fromtimestamp(at).strftime("%Y-%m-%d")


@dataclass(slots=True)
class UsageSession:
    """一个会话的内存账本（只加不减，flush 时交出两种视图）。

    视图一：绝对值 —— session 表整行覆盖（幂等，重复 flush 也只有一个结果）；
    视图二：增量 —— char_usage / daily 用加法，故必须 drain。
    """

    session_id: str
    char_id: str
    started_at: float
    char_started_at: float
    last_activity_at: float
    ended_at: float | None = None
    duration_sec: float = 0.0
    msg_count: int = 0
    interrupt_count: int = 0
    voice_msg_count: int = 0
    text_msg_count: int = 0
    screen_capture_count: int = 0
    llm_provider: str = ""
    asr_provider: str = ""
    tts_provider: str = ""
    pending_char_seconds: dict[str, float] = field(default_factory=dict)
    pending_char_sessions: dict[str, int] = field(default_factory=dict)
    pending_daily_seconds: float = 0.0
    pending_daily_msgs: int = 0
    pending_daily_sessions: int = 0

    @classmethod
    def start(
        cls,
        session_id: str,
        char_id: str,
        *,
        at: float,
        providers: ProviderNames | None = None,
    ) -> UsageSession:
        """新会话：会话次数在开始时就记一次（切换角色时新角色再记一次）。

        providers 是启动时的模型供给选择（§6.13）；llm 之后会被实际用上的端点覆盖。
        """
        names = providers or ProviderNames()
        session = cls(
            session_id=session_id,
            char_id=char_id,
            started_at=at,
            char_started_at=at,
            last_activity_at=at,
            llm_provider=names.llm,
            asr_provider=names.asr,
            tts_provider=names.tts,
        )
        session.pending_char_sessions[char_id] = 1
        session.pending_daily_sessions = 1
        return session

    @property
    def closed(self) -> bool:
        """会话是否已收尾（收尾后不再累计时长）。"""
        return self.ended_at is not None

    def accrue(self, at: float) -> None:
        """结算「当前角色片段」的时长；结算后片段从此刻重新开始（可反复调用）。"""
        self.last_activity_at = at
        elapsed = max(at - self.char_started_at, 0.0)
        self.char_started_at = at
        if elapsed <= 0.0:
            return
        self.duration_sec += elapsed
        self.pending_char_seconds[self.char_id] = (
            self.pending_char_seconds.get(self.char_id, 0.0) + elapsed
        )
        self.pending_daily_seconds += elapsed

    def record_message(self, at: float, *, voice: bool) -> None:
        """记一轮用户输入（voice 为 True 记进 voice_msg_count，否则 text_msg_count）。"""
        self.accrue(at)
        self.msg_count += 1
        self.pending_daily_msgs += 1
        if voice:
            self.voice_msg_count += 1
        else:
            self.text_msg_count += 1

    def record_interrupt(self, at: float) -> None:
        """记一次打断（用户没等角色说完就发新话或点了打断）。"""
        self.accrue(at)
        self.interrupt_count += 1

    def record_screen_capture(self, at: float) -> None:
        """记一次屏幕识别（M4 的 F7 才会上报，这里先把字段接上）。"""
        self.accrue(at)
        self.screen_capture_count += 1

    def switch_to(self, char_id: str, at: float) -> None:
        """会话中途换了角色：先结清上一个角色的时长，再给新角色记一次会话。"""
        if char_id == self.char_id:
            return
        self.accrue(at)
        self.char_id = char_id
        self.pending_char_sessions[char_id] = self.pending_char_sessions.get(char_id, 0) + 1

    def close(self, at: float) -> None:
        """收尾：结清最后一段时长并记下结束时间（重复调用无副作用）。"""
        if self.closed:
            return
        self.accrue(at)
        self.ended_at = at

    def idle_for(self, at: float) -> float:
        """距上次活动过了多少秒（判空闲会话是否该收尾）。"""
        return max(at - self.last_activity_at, 0.0)

    def set_provider(self, name: str) -> None:
        """回填本轮实际使用的 LLM 供给（切到备用或另一个 provider 后覆盖配置值）。"""
        self.llm_provider = name

    def to_row(self) -> SessionRow:
        """会话表的当前视图（char_id 记的是本次会话最后使用的角色）。"""
        return SessionRow(
            session_id=self.session_id,
            char_id=self.char_id,
            started_at=self.started_at,
            ended_at=self.ended_at,
            duration_sec=self.duration_sec,
            msg_count=self.msg_count,
            interrupt_count=self.interrupt_count,
            voice_msg_count=self.voice_msg_count,
            text_msg_count=self.text_msg_count,
            screen_capture_count=self.screen_capture_count,
            llm_provider=self.llm_provider,
            asr_provider=self.asr_provider,
            tts_provider=self.tts_provider,
        )

    def drain(self) -> UsageDeltas:
        """交出增量并清零（**必须在写入成功之后调用**，调用方负责顺序）。"""
        deltas = UsageDeltas(
            char_seconds=dict(self.pending_char_seconds),
            char_sessions=dict(self.pending_char_sessions),
            daily_seconds=self.pending_daily_seconds,
            daily_msgs=self.pending_daily_msgs,
            daily_sessions=self.pending_daily_sessions,
        )
        self.pending_char_seconds.clear()
        self.pending_char_sessions.clear()
        self.pending_daily_seconds = 0.0
        self.pending_daily_msgs = 0
        self.pending_daily_sessions = 0
        return deltas
