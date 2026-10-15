"""文件职责：使用统计的编排层——内存账本 + 批量写盘 + 暂停记录开关。

依赖方向：services 依赖 core（UsageSession / UsageStore Protocol / 日志）与注入的存储实现，
不 import adapters（CODE_STYLE §1.1）；存储实例由 build_usage_service(settings) 装配，
组合根 app.py 调用。
谁调用：sidecar/app.py 建实例并注入 ChatService / 路由；ChatService 只通过 UsageRecorder 接口
报事实（record_turn / record_interrupt），不知道有 SQLite 这回事。

为什么要有这一层（§6.9）：会话期间**不逐条写盘**，把「什么时候落、落哪几张表、失败了怎么办」
集中在这里；写失败是 A 级错误，只记日志、绝不影响对话。

写盘的顺序约束：char_usage / daily 是累加表，所以**先写入、后 drain**（少算一次可以接受，
多算一次就永远还不起）。因此整批写入放在一个线程里顺序执行。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

from adapters.usage_sqlite import UsageSqliteStore
from config import Settings
from core.logging import get_logger, log_event
from core.usage import (
    DEFAULT_FLUSH_INTERVAL_S,
    DEFAULT_IDLE_TIMEOUT_S,
    META_RECORDING_ENABLED,
    RECORDING_DISABLED_VALUE,
    RECORDING_ENABLED_VALUE,
    UsageSession,
    UsageStore,
    day_key,
)

LOGGER = get_logger("services.usage")

#: 日志模块名（sidecar.services.usage）
_LOG_MODULE = "sidecar.services.usage"


class UsageService:
    """使用统计的内存账本与落盘编排（F10 / §6.9）。

    它是 core.usage.UsageRecorder 的生产实现：满足与否由组合根（app.py）传给 ChatService
    时的类型注解核对，本模块不需要 import 那个 Protocol。
    """

    def __init__(
        self,
        store: UsageStore,
        *,
        now: Callable[[], float] = time.time,
        flush_interval_s: float = DEFAULT_FLUSH_INTERVAL_S,
        idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
    ) -> None:
        self._store = store
        self._now = now
        self._flush_interval_s = flush_interval_s
        self._idle_timeout_s = idle_timeout_s
        self._sessions: dict[str, UsageSession] = {}
        self._pending_switches: list[tuple[float, str | None, str]] = []
        self._last_flush_at = now()
        self._lock = asyncio.Lock()
        # 自上次成功落盘以来有没有新事实；没有就不必写盘，也不必刷新 flush 计时
        self._dirty = False
        # 记录开关也要惰性读：构造 app 时不该为了统计去建一个 usage.db。
        self._enabled = True
        self._enabled_loaded = False

    # ------------------------------------------------------------ 对外状态

    @property
    def enabled(self) -> bool:
        """是否正在记录（读一次 meta 后缓存；默认开）。"""
        self._load_enabled_if_needed()
        return self._enabled

    @property
    def open_session_count(self) -> int:
        """当前还开着的会话数（测试与排障用）。"""
        return sum(1 for session in self._sessions.values() if not session.closed)

    # ------------------------------------------------------------ 记录事实

    def record_turn(
        self, session_id: str, char_id: str, *, voice: bool, at: float | None = None
    ) -> None:
        """记一轮用户输入；这是 ChatService 唯一的写入口（同步、不落盘、不抛错）。"""
        if not self._recording():
            return
        now = self._now() if at is None else at
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            # 新会话不代表「这一轮已经记好了」：接着往下走，把本轮消息也记进去
            session = UsageSession.start(session_id, char_id, at=now)
            self._sessions[session_id] = session
        elif session.char_id != char_id:
            self._pending_switches.append((now, session.char_id, char_id))
            session.switch_to(char_id, now)
        session.record_message(now, voice=voice)
        self._dirty = True

    def record_interrupt(self, session_id: str, *, at: float | None = None) -> None:
        """记一次打断；没有对应会话就忽略（打断事件可能比第一轮输入更早到）。"""
        if not self._recording():
            return
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            return
        session.record_interrupt(self._now() if at is None else at)
        self._dirty = True

    def record_screen_capture(self, session_id: str, *, at: float | None = None) -> None:
        """记一次屏幕识别（F7 在 M4 接上，这里先把字段留着）。"""
        if not self._recording():
            return
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            return
        session.record_screen_capture(self._now() if at is None else at)
        self._dirty = True

    # ------------------------------------------------------------ 落盘

    async def flush(self, *, close_all: bool = False) -> bool:
        """把内存里的账本写进 usage.db；返回是否真的写了。

        close_all=True 用于优雅退出：把所有会话收尾，下一次启动就是干净的新会话。
        """
        async with self._lock:
            self._load_enabled_if_needed()
            at = self._now()
            if not self._enabled:
                self._last_flush_at = at
                return False
            self._settle_sessions(at, close_all=close_all)
            sessions = list(self._sessions.values())
            switches = list(self._pending_switches)
            if not sessions and not switches:
                self._last_flush_at = at
                return False
            # 没有新事实、也没有刚收尾的会话，就没有写盘的必要（否则每次心跳都会空写一遍）
            if not self._dirty and not any(session.closed for session in sessions):
                self._last_flush_at = at
                return False
            try:
                await asyncio.to_thread(self._write_batch, sessions, switches, at)
            except Exception as exc:  # 统计写失败绝不能打断对话（§6.7 A 级）
                log_event(
                    LOGGER,
                    logging.ERROR,
                    module=_LOG_MODULE,
                    event="usage.write_failed",
                    message="使用统计写入失败，已跳过本次（不影响对话）",
                    fields={"error": type(exc).__name__, "detail": str(exc)},
                )
                return False
            self._pending_switches = self._pending_switches[len(switches) :]
            for session_id, session in list(self._sessions.items()):
                if session.closed:
                    del self._sessions[session_id]
            self._dirty = False
            self._last_flush_at = at
            return True

    async def flush_if_due(self) -> bool:
        """距上次落盘够一个批量窗口才写（每轮对话结束时调用，§6.9 的「每 5 分钟」）。"""
        if self._now() - self._last_flush_at < self._flush_interval_s:
            return False
        return await self.flush()

    async def stop(self) -> None:
        """退出前收尾：把开着的会话写完并关掉连接。"""
        await self.flush(close_all=True)
        try:
            await asyncio.to_thread(self._store.close)
        except Exception as exc:  # 关连接失败也只是日志
            log_event(
                LOGGER,
                logging.WARNING,
                module=_LOG_MODULE,
                event="usage.close_failed",
                message="关闭 usage.db 失败（数据已写入，忽略）",
                fields={"error": type(exc).__name__, "detail": str(exc)},
            )

    async def clear(self) -> bool:
        """清空统计（用户主动操作；不动记忆、不动 meta）。"""
        async with self._lock:
            self._sessions.clear()
            self._pending_switches.clear()
            try:
                await asyncio.to_thread(self._store.clear_usage)
            except Exception as exc:
                log_event(
                    LOGGER,
                    logging.ERROR,
                    module=_LOG_MODULE,
                    event="usage.clear_failed",
                    message="清空使用统计失败",
                    fields={"error": type(exc).__name__, "detail": str(exc)},
                )
                return False
            return True

    async def set_enabled(self, enabled: bool) -> bool:
        """切换「暂停记录」：关掉时丢弃内存里未落盘的账本（暂停就是暂停）。"""
        async with self._lock:
            self._enabled_loaded = True
            self._enabled = enabled
            if not enabled:
                self._sessions.clear()
                self._pending_switches.clear()
                self._dirty = False
            value = RECORDING_ENABLED_VALUE if enabled else RECORDING_DISABLED_VALUE
            try:
                await asyncio.to_thread(self._store.write_meta, META_RECORDING_ENABLED, value)
            except Exception as exc:
                log_event(
                    LOGGER,
                    logging.ERROR,
                    module=_LOG_MODULE,
                    event="usage.meta_failed",
                    message="记录开关写入失败（本次生效，下次启动会回到旧值）",
                    fields={"error": type(exc).__name__, "detail": str(exc)},
                )
                return False
            return True

    # ------------------------------------------------------------ 内部

    def _recording(self) -> bool:
        """记录前先确认开关（首次调用会读一次 meta）。"""
        self._load_enabled_if_needed()
        return self._enabled

    def _load_enabled_if_needed(self) -> None:
        if self._enabled_loaded:
            return
        self._enabled_loaded = True
        try:
            value = self._store.read_meta(META_RECORDING_ENABLED)
        except Exception as exc:  # 读不到就按默认（开）继续
            log_event(
                LOGGER,
                logging.WARNING,
                module=_LOG_MODULE,
                event="usage.meta_unreadable",
                message="读取记录开关失败，按默认（记录）继续",
                fields={"error": type(exc).__name__, "detail": str(exc)},
            )
            return
        self._enabled = value != RECORDING_DISABLED_VALUE

    def _settle_sessions(self, at: float, *, close_all: bool) -> None:
        """写盘前把账本结算到「现在」：开着的会话也要结当前片段，空闲超时的顺手收尾。

        少了「仍开着的也 accrue」这一步，flush 出来的时长会停在最后一次记消息的时刻
        （会话越安静、少算得越多）。
        """
        for session in self._sessions.values():
            if session.closed:
                continue
            if close_all or session.idle_for(at) >= self._idle_timeout_s:
                session.close(at)
            else:
                session.accrue(at)

    def _write_batch(
        self,
        sessions: list[UsageSession],
        switches: list[tuple[float, str | None, str]],
        at: float,
    ) -> None:
        """一个线程里顺序写完整批（先写入、后 drain；失败向上抛给 flush 兜底）。"""
        for switch_at, from_char_id, to_char_id in switches:
            self._store.append_switch(switch_at, from_char_id, to_char_id)
        for session in sessions:
            self._store.write_session(session.to_row())
            deltas = session.drain()
            for char_id in sorted(set(deltas.char_seconds) | set(deltas.char_sessions)):
                self._store.add_char_usage(
                    char_id,
                    seconds=deltas.char_seconds.get(char_id, 0.0),
                    sessions=deltas.char_sessions.get(char_id, 0),
                    at=at,
                )
            if deltas.daily_seconds > 0.0 or deltas.daily_msgs > 0 or deltas.daily_sessions > 0:
                self._store.add_daily(
                    day_key(at),
                    duration_sec=deltas.daily_seconds,
                    session_count=deltas.daily_sessions,
                    msg_count=deltas.daily_msgs,
                )


def build_usage_service(settings: Settings) -> UsageService:
    """按设置装配使用统计（<数据目录>/usage.db，与 memories.db 分离，§6.9）。"""
    return UsageService(UsageSqliteStore(settings.usage_db_file))
