"""文件职责：环境事件契约与进程内事件总线（需求 §6.8，F9 的输入）。

依赖方向：core 纯逻辑，只依赖标准库；不 import adapters / services / api。
谁调用：services 层（ASR / TTS / 会话）上报事实；M4 的提示词装配器与 UI 各取一份视图。

约定（§6.8）：
- 事件只能由模块上报，**LLM 无权产生事件**；
- fact 与 user_hint 分离：user_hint 是给用户看的排查指引，**永不进入提示词**——
  render_facts() 只读 fact，这条是 F9 验收里的硬要求；
- 总线只做两件事：按 dedup_key 去重、按 ttl 过期；限频与开关由装配层（M4）判定；
- 默认去重键 = 事件类型 + 本进程实例号（进程内的同类事件只留一条，不刷屏）。

为什么 M1 就把总线立起来：事件源散落在 ASR / TTS / 网络 / 记忆各模块里（§8.1 P1），
晚加要回头改所有模块；表现层 F9 放 M4，届时只消费这里的 active()，不必再动各模块。
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol

# --- 错误级别（与 §6.7 的三级一致）---------------------------------------
LEVEL_A = "A"
"""可自愈：自动重试 / 降级就能继续。"""
LEVEL_B = "B"
"""需用户处理：缺东西或要授权。"""
LEVEL_C = "C"
"""致命：进程级不可用。"""

# --- 十种事件类型（§6.8 的 id 列，冻结）-----------------------------------
EVENT_TTS_FAILED = "tts.failed"
EVENT_ASR_EMPTY = "asr.empty"
EVENT_NET_DOWN = "net.down"
EVENT_MIC_BUSY = "mic.busy"
EVENT_SCREEN_OCR_FAILED = "screen.ocr_failed"
EVENT_MEM_READONLY = "mem.readonly"
EVENT_MEM_KEY_INVALID = "mem.key_invalid"
EVENT_ENGINE_NOT_LOADED = "engine.not_loaded"
EVENT_PRESENCE_IDLE_LONG = "presence.idle_long"
EVENT_TIME_LATE_NIGHT = "time.late_night"

EVENT_IDS: tuple[str, ...] = (
    EVENT_TTS_FAILED,
    EVENT_ASR_EMPTY,
    EVENT_NET_DOWN,
    EVENT_MIC_BUSY,
    EVENT_SCREEN_OCR_FAILED,
    EVENT_MEM_READONLY,
    EVENT_MEM_KEY_INVALID,
    EVENT_ENGINE_NOT_LOADED,
    EVENT_PRESENCE_IDLE_LONG,
    EVENT_TIME_LATE_NIGHT,
)


@dataclass(frozen=True, slots=True)
class EventSpec:
    """一种事件的默认级别与有效期；上报时可以按次覆盖。"""

    level: str
    ttl_s: float


#: 默认级别 / ttl 秒。ttl 的取舍：瞬时故障短（识别没听清、OCR 失败），
#: 需要用户动手的长（引擎没在跑、密钥失效），避免角色一直"病着"（§6.8）。
DEFAULT_EVENT_SPECS: dict[str, EventSpec] = {
    EVENT_TTS_FAILED: EventSpec(LEVEL_B, 300.0),
    EVENT_ASR_EMPTY: EventSpec(LEVEL_A, 120.0),
    EVENT_NET_DOWN: EventSpec(LEVEL_B, 300.0),
    EVENT_MIC_BUSY: EventSpec(LEVEL_B, 300.0),
    EVENT_SCREEN_OCR_FAILED: EventSpec(LEVEL_A, 120.0),
    EVENT_MEM_READONLY: EventSpec(LEVEL_B, 3600.0),
    EVENT_MEM_KEY_INVALID: EventSpec(LEVEL_B, 86400.0),
    EVENT_ENGINE_NOT_LOADED: EventSpec(LEVEL_B, 600.0),
    EVENT_PRESENCE_IDLE_LONG: EventSpec(LEVEL_A, 3600.0),
    EVENT_TIME_LATE_NIGHT: EventSpec(LEVEL_A, 3600.0),
}


@dataclass(frozen=True, slots=True)
class EnvEvent:
    """一条环境事件：§6.8 的七个字段，字段名与契约表逐字对应。"""

    id: str
    level: str
    fact: str
    user_hint: str
    since: float
    dedup_key: str
    ttl: float

    @property
    def expires_at(self) -> float:
        """失效时刻（since + ttl）。"""
        return self.since + self.ttl

    def is_active(self, now: float) -> bool:
        """是否仍然有效；过期的状态视为已恢复（§6.8）。"""
        return now < self.expires_at

    def to_payload(self) -> dict[str, str | float]:
        """转成可序列化的字典（将来给 UI / 日志用，形状与 §6.8 一致）。"""
        return {
            "id": self.id,
            "level": self.level,
            "fact": self.fact,
            "user_hint": self.user_hint,
            "since": self.since,
            "dedup_key": self.dedup_key,
            "ttl": self.ttl,
        }


class EnvEventReporter(Protocol):
    """模块上报事件的最小接口（services 只依赖它，方便注入假实现）。"""

    def report(
        self,
        event_id: str,
        *,
        fact: str,
        user_hint: str = "",
        level: str | None = None,
        dedup_key: str | None = None,
        ttl_s: float | None = None,
    ) -> EnvEvent: ...

    def clear(self, *, dedup_key: str | None = None, event_id: str | None = None) -> int: ...


class EnvEventBus:
    """进程内事件总线：上报 → 去重 → 过期 → 供 UI / 装配器读取。

    线程说明：实例字典没有加锁——上报只发生在事件循环线程（各 service 的异步入口），
    这也是 §6.8「事件只能由模块上报」的落地方式：谁出事谁在此登记。
    """

    def __init__(
        self,
        *,
        now: Callable[[], float] = time.time,
        instance: str | None = None,
    ) -> None:
        self._now = now
        self._instance = instance if instance is not None else str(os.getpid())
        self._events: dict[str, EnvEvent] = {}
        self._listeners: list[Callable[[tuple[EnvEvent, ...]], None]] = []

    # ------------------------------------------------------------ 上报 / 撤销

    def report(
        self,
        event_id: str,
        *,
        fact: str,
        user_hint: str = "",
        level: str | None = None,
        dedup_key: str | None = None,
        ttl_s: float | None = None,
    ) -> EnvEvent:
        """登记一条事件；同 dedup_key 的旧事件被替换（条件仍在则保留原 since）。

        事件类型必须来自 EVENT_IDS——写错事件名比没有事件更难查，所以直接报错。
        """
        spec = DEFAULT_EVENT_SPECS.get(event_id)
        if spec is None:
            raise ValueError("未知的环境事件类型（应为 §6.8 的十种之一）：" + repr(event_id))
        now = self._now()
        key = dedup_key if dedup_key is not None else self._default_key(event_id)
        previous = self._events.get(key)
        started_at = previous.since if previous is not None and previous.is_active(now) else now
        event = EnvEvent(
            id=event_id,
            level=level if level is not None else spec.level,
            fact=fact,
            user_hint=user_hint,
            since=started_at,
            dedup_key=key,
            ttl=ttl_s if ttl_s is not None else spec.ttl_s,
        )
        self._events[key] = event
        self._notify()
        return event

    def clear(self, *, dedup_key: str | None = None, event_id: str | None = None) -> int:
        """撤销事件（条件恢复）：按 dedup_key、按类型，或两者都给（取交集）。"""
        targets = [
            key
            for key, event in self._events.items()
            if (dedup_key is None or key == dedup_key)
            and (event_id is None or event.id == event_id)
        ]
        for key in targets:
            del self._events[key]
        if targets:
            self._notify()
        return len(targets)

    # ------------------------------------------------------------ 读取

    def active(self, *, now: float | None = None) -> tuple[EnvEvent, ...]:
        """当前仍有效的事件列表（未过期即为仍未恢复），按级别与开始时间排序。"""
        moment = self._now() if now is None else now
        alive = [event for event in self._events.values() if event.is_active(moment)]
        alive.sort(key=lambda event: (event.level, event.since, event.id, event.dedup_key))
        return tuple(alive)

    def prune(self, *, now: float | None = None) -> int:
        """丢掉已过期的事件，返回丢弃条数（长时间运行时顺手清理内存）。"""
        moment = self._now() if now is None else now
        dead = [key for key, event in self._events.items() if not event.is_active(moment)]
        for key in dead:
            del self._events[key]
        return len(dead)

    def subscribe(self, listener: Callable[[tuple[EnvEvent, ...]], None]) -> Callable[[], None]:
        """订阅变化（UI 推送用）；返回退订函数。"""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    # ------------------------------------------------------------ 内部

    def _default_key(self, event_id: str) -> str:
        """默认去重键 = 事件类型 + 本进程实例号（§6.8）。"""
        return event_id + "@" + self._instance

    def _notify(self) -> None:
        snapshot = self.active()
        for listener in list(self._listeners):
            listener(snapshot)


def render_facts(events: Iterable[EnvEvent]) -> list[str]:
    """把事件渲染成给提示词用的状态行—**只含 fact，绝不含 user_hint**（§6.8）。

    F9 的表现层（M4）会把它塞进系统提示词；放在这里是为了让「排查指引不进提示词」
    这条规则可被单测直接盯住。
    """
    return ["[" + event.level + "] " + event.id + "：" + event.fact for event in events]


#: 角色能理解的说法；内部事件名与错误码不进入人设提示词（F9）。
_CHARACTER_FACT_BY_EVENT: dict[str, str] = {
    EVENT_TTS_FAILED: "你刚才想说话，但声音没能发出来。",
    EVENT_ASR_EMPTY: "你刚才没听清对方说了什么。",
    EVENT_NET_DOWN: "你现在连不上网络。",
    EVENT_MIC_BUSY: "麦克风正被别的程序占用。",
    EVENT_SCREEN_OCR_FAILED: "你刚才没能看清屏幕上的内容。",
    EVENT_MEM_READONLY: "你刚才想记住什么，但记忆暂时写不进去。",
    EVENT_MEM_KEY_INVALID: "你的记忆暂时打不开。",
    EVENT_ENGINE_NOT_LOADED: "你的某个能力暂时还没准备好。",
    EVENT_PRESENCE_IDLE_LONG: "对方已经有一阵子没动了。",
    EVENT_TIME_LATE_NIGHT: "现在是深夜。",
}


def render_character_facts(events: Iterable[EnvEvent]) -> list[str]:
    """只把角色能体验到的部分渲染成人话，不暴露事件 id / 级别 / 错误码。"""
    return [_CHARACTER_FACT_BY_EVENT.get(event.id, event.fact) for event in events]


__all__ = [
    "DEFAULT_EVENT_SPECS",
    "EVENT_ASR_EMPTY",
    "EVENT_ENGINE_NOT_LOADED",
    "EVENT_IDS",
    "EVENT_MEM_KEY_INVALID",
    "EVENT_MEM_READONLY",
    "EVENT_MIC_BUSY",
    "EVENT_NET_DOWN",
    "EVENT_PRESENCE_IDLE_LONG",
    "EVENT_SCREEN_OCR_FAILED",
    "EVENT_TIME_LATE_NIGHT",
    "EVENT_TTS_FAILED",
    "LEVEL_A",
    "LEVEL_B",
    "LEVEL_C",
    "EnvEvent",
    "EnvEventBus",
    "EnvEventReporter",
    "EventSpec",
    "render_character_facts",
    "render_facts",
]
