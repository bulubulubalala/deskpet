"""角色的持久状态：让心情、精力、关系和注意力跨轮次保持一致（F9 / F5）。

状态只描述角色自己的内在连续性，不记录聊天正文；聊天内容仍归 core.memory。
所有更新都是确定性的，提示词里不再每轮随机抽心情。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, replace
from typing import Any

#: 最近话题只留几条，避免状态膨胀成第二份聊天记录
RECENT_TOPIC_LIMIT = 5
#: 未完成事项只留几条，旧的由记忆层负责长期保存
OPEN_LOOP_LIMIT = 5
#: 一段话题最多保留的字符数
TOPIC_CHARS = 32

MOOD_MORNING = "心情不错，乐意搭话"
MOOD_DAY = "情绪平平，谈不上高兴也谈不上烦"
MOOD_EVENING = "有点好奇，想多问一句"
MOOD_NIGHT = "有点倦，反应偏慢"
MOOD_LATE = "心里装着自己的事，话不多"

RELATION_FAR = "你们刚认识不久，你还在观察对方"
RELATION_NEAR = "你们算熟了，说话不必客气"
RELATION_CLOSE = "你们关系很近，你可以直接表达亲近或不满"

ENERGY_LOW = "精力不太够"
ENERGY_MID = "精力还行"
ENERGY_HIGH = "精力不错"


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return min(high, max(low, value))


def _unit_to_words(value: float, *, low: str, mid: str, high: str) -> str:
    if value < 0.34:
        return low
    if value < 0.67:
        return mid
    return high


def _hour_of(now: float) -> int:
    return time.localtime(now).tm_hour


def mood_for_hour(hour: int) -> str:
    if 5 <= hour < 9:
        return MOOD_MORNING
    if 9 <= hour < 18:
        return MOOD_DAY
    if 18 <= hour < 22:
        return MOOD_EVENING
    if 22 <= hour < 24:
        return MOOD_NIGHT
    return MOOD_LATE


def energy_for_hour(hour: int) -> float:
    if 0 <= hour < 6:
        return 0.3
    if 6 <= hour < 10:
        return 0.65
    if 10 <= hour < 18:
        return 0.75
    if 18 <= hour < 23:
        return 0.55
    return 0.35


def _clean_topic(text: str) -> str:
    return " ".join(text.split())[:TOPIC_CHARS]


@dataclass(frozen=True, slots=True)
class OpenLoop:
    """一件还悬着的事；due_at=0 表示没有明确时间。"""

    text: str
    due_at: float = 0.0
    created_at: float = 0.0

    def to_payload(self) -> dict[str, object]:
        return {"text": self.text, "due_at": self.due_at, "created_at": self.created_at}

    @classmethod
    def from_payload(cls, raw: object) -> OpenLoop | None:
        if isinstance(raw, str):
            text = _clean_topic(raw)
            return cls(text=text) if text else None
        if not isinstance(raw, dict):
            return None
        text = _clean_topic(str(raw.get("text", "")))
        if not text:
            return None
        return cls(
            text=text,
            due_at=float(raw.get("due_at", 0.0) or 0.0),
            created_at=float(raw.get("created_at", 0.0) or 0.0),
        )


@dataclass(frozen=True, slots=True)
class CharacterState:
    """一个角色的内在状态；由 MemoryService 落盘，ChatService 每轮读取。"""

    char_id: str
    relationship: float = 0.5
    mood: str = MOOD_DAY
    energy: float = 0.65
    attention: str = "idle"
    last_user_at: float = 0.0
    last_assistant_at: float = 0.0
    last_proactive_at: float = 0.0
    last_proactive_kind: str = ""
    proactive_ignored_streak: int = 0
    proactive_hour_key: int = 0
    proactive_hour_count: int = 0
    recent_topics: tuple[str, ...] = ()
    open_loops: tuple[OpenLoop, ...] = ()
    updated_at: float = 0.0

    @classmethod
    def seed(cls, char_id: str, *, relationship: float = 0.5, now: float = 0.0) -> CharacterState:
        moment = time.time() if now <= 0 else now
        hour = _hour_of(moment)
        return cls(
            char_id=char_id,
            relationship=_clamp(relationship),
            mood=mood_for_hour(hour),
            energy=energy_for_hour(hour),
            updated_at=moment,
        )

    def refresh(self, now: float) -> CharacterState:
        """时间跨过时段时更新心情；同一时段内不随机跳变。"""
        moment = now if now > 0 else time.time()
        previous_hour = _hour_of(self.updated_at) if self.updated_at > 0 else -1
        current_hour = _hour_of(moment)
        if previous_hour >= 0 and previous_hour // 6 == current_hour // 6:
            return replace(self, updated_at=moment)
        return replace(
            self,
            mood=mood_for_hour(current_hour),
            energy=energy_for_hour(current_hour),
            updated_at=moment,
        )

    def after_user_turn(self, text: str, *, now: float) -> CharacterState:
        """用户说过话：推进关系、消耗一点精力、记下最近话题。"""
        topic = _clean_topic(text)
        topics = self.recent_topics
        if topic:
            topics = tuple(item for item in topics if item != topic)[-RECENT_TOPIC_LIMIT + 1 :]
            topics = (*topics, topic)
        return replace(
            self,
            relationship=_clamp(self.relationship + 0.002),
            energy=_clamp(self.energy - 0.01, 0.1, 1.0),
            last_user_at=now,
            last_assistant_at=self.last_assistant_at,
            recent_topics=topics,
            updated_at=now,
        )

    def after_assistant_turn(self, *, now: float) -> CharacterState:
        return replace(
            self,
            energy=_clamp(self.energy - 0.005, 0.1, 1.0),
            last_assistant_at=now,
            updated_at=now,
        )

    def after_proactive(self, kind: str, *, now: float) -> CharacterState:
        hour_key = int(now // 3600)
        count = self.proactive_hour_count + 1 if self.proactive_hour_key == hour_key else 1
        return replace(
            self,
            last_proactive_at=now,
            last_proactive_kind=kind,
            proactive_hour_key=hour_key,
            proactive_hour_count=count,
            updated_at=now,
        )

    def after_proactive_outcome(self, *, responded: bool, now: float) -> CharacterState:
        streak = 0 if responded else self.proactive_ignored_streak + 1
        return replace(
            self,
            proactive_ignored_streak=streak,
            relationship=_clamp(self.relationship + (0.002 if responded else -0.001)),
            updated_at=now,
        )

    def with_attention(self, attention: str, *, now: float) -> CharacterState:
        return replace(self, attention=attention, updated_at=now)

    def with_open_loop(self, text: str, *, due_at: float = 0.0, now: float) -> CharacterState:
        body = _clean_topic(text)
        if not body:
            return self
        loops = tuple(item for item in self.open_loops if item.text != body)
        loops = (*loops[-(OPEN_LOOP_LIMIT - 1) :], OpenLoop(body, due_at=due_at, created_at=now))
        return replace(self, open_loops=loops, updated_at=now)

    def due_open_loops(self, now: float) -> tuple[OpenLoop, ...]:
        return tuple(item for item in self.open_loops if item.due_at <= 0 or item.due_at <= now)

    def without_open_loop(self, text: str) -> CharacterState:
        body = _clean_topic(text)
        return replace(
            self,
            open_loops=tuple(item for item in self.open_loops if item.text != body),
        )

    def render(self, *, now: float | None = None) -> str:
        """拼给提示词的状态行；不出现内部事件名或技术错误码。"""
        moment = time.time() if now is None else now
        state = self.refresh(moment) if self.updated_at > 0 else self
        relationship = _unit_to_words(
            state.relationship,
            low=RELATION_FAR,
            mid=RELATION_NEAR,
            high=RELATION_CLOSE,
        )
        energy = _unit_to_words(
            state.energy,
            low=ENERGY_LOW,
            mid=ENERGY_MID,
            high=ENERGY_HIGH,
        )
        parts = [
            "现在是" + _time_label(_hour_of(moment)),
            "你" + state.mood,
            energy,
            relationship,
        ]
        if state.recent_topics:
            parts.append("你们最近聊到「" + "」「".join(state.recent_topics[-2:]) + "」")
        loops = state.due_open_loops(moment)
        if loops:
            parts.append("你还记着要问「" + loops[-1].text + "」")
        return "；".join(parts) + "。"

    def to_storage(self) -> tuple[str, str, float, float, int, float]:
        relation = json.dumps(
            {
                "relationship": self.relationship,
                "last_user_at": self.last_user_at,
                "last_assistant_at": self.last_assistant_at,
            },
            ensure_ascii=False,
        )
        mood = json.dumps(
            {
                "mood": self.mood,
                "energy": self.energy,
                "attention": self.attention,
                "recent_topics": list(self.recent_topics),
                "open_loops": [item.to_payload() for item in self.open_loops],
                "last_proactive_kind": self.last_proactive_kind,
                "proactive_hour_key": self.proactive_hour_key,
                "proactive_hour_count": self.proactive_hour_count,
            },
            ensure_ascii=False,
        )
        return (
            relation,
            mood,
            max(self.last_user_at, self.last_assistant_at),
            self.last_proactive_at,
            self.proactive_ignored_streak,
            self.updated_at,
        )

    @classmethod
    def from_storage(
        cls,
        char_id: str,
        *,
        relation_json: str = "",
        mood_json: str = "",
        last_seen_ts: float = 0.0,
        last_proactive_ts: float = 0.0,
        ignored_streak: int = 0,
        updated_at: float = 0.0,
    ) -> CharacterState:
        relation = _load_object(relation_json)
        mood = _load_object(mood_json)
        loops: list[OpenLoop] = []
        raw_loops = mood.get("open_loops")
        if isinstance(raw_loops, list):
            for raw in raw_loops:
                loop = OpenLoop.from_payload(raw)
                if loop is not None:
                    loops.append(loop)
        raw_topics = mood.get("recent_topics")
        topics = (
            tuple(_clean_topic(str(item)) for item in raw_topics if str(item).strip())
            if isinstance(raw_topics, list)
            else ()
        )
        return cls(
            char_id=char_id,
            relationship=_clamp(float(relation.get("relationship", 0.5) or 0.5)),
            mood=str(mood.get("mood", MOOD_DAY) or MOOD_DAY),
            energy=_clamp(float(mood.get("energy", 0.65) or 0.65)),
            attention=str(mood.get("attention", "idle") or "idle"),
            last_user_at=float(relation.get("last_user_at", 0.0) or 0.0),
            last_assistant_at=float(relation.get("last_assistant_at", 0.0) or 0.0),
            last_proactive_at=float(last_proactive_ts or 0.0),
            last_proactive_kind=str(mood.get("last_proactive_kind", "") or ""),
            proactive_ignored_streak=max(0, int(ignored_streak or 0)),
            proactive_hour_key=int(mood.get("proactive_hour_key", 0) or 0),
            proactive_hour_count=max(0, int(mood.get("proactive_hour_count", 0) or 0)),
            recent_topics=topics[-RECENT_TOPIC_LIMIT:],
            open_loops=tuple(loops[-OPEN_LOOP_LIMIT:]),
            updated_at=float(updated_at or last_seen_ts or 0.0),
        )


def _load_object(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _time_label(hour: int) -> str:
    if 0 <= hour < 5:
        return "凌晨"
    if 5 <= hour < 9:
        return "早上"
    if 9 <= hour < 12:
        return "上午"
    if 12 <= hour < 18:
        return "下午"
    if 18 <= hour < 22:
        return "傍晚"
    return "深夜"


__all__ = [
    "MOOD_DAY",
    "MOOD_EVENING",
    "MOOD_LATE",
    "MOOD_MORNING",
    "MOOD_NIGHT",
    "OPEN_LOOP_LIMIT",
    "RECENT_TOPIC_LIMIT",
    "CharacterState",
    "OpenLoop",
    "energy_for_hour",
    "mood_for_hour",
]
