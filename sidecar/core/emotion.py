"""文件职责：轻量情绪标注（T2.39）：从中文文本估一个效价 / 唤醒度。

为什么不用模型：情绪标注是检索加分项，不能为每轮召回再花一次 LLM；
词表足够覆盖日常对话里的明显情绪，找不到词时返回中性。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class EmotionTag:
    valence: float = 0.0
    arousal: float = 0.0
    label: str = "neutral"


_POSITIVE = {
    "开心": (0.8, 0.6),
    "高兴": (0.7, 0.5),
    "喜欢": (0.8, 0.5),
    "顺利": (0.6, 0.3),
    "惊喜": (0.9, 0.8),
    "安心": (0.6, 0.2),
    "温暖": (0.7, 0.3),
    "期待": (0.6, 0.6),
    "舒服": (0.6, 0.2),
    "轻松": (0.5, 0.2),
    "满足": (0.7, 0.3),
    "感动": (0.8, 0.5),
    "棒": (0.7, 0.5),
    "好": (0.3, 0.2),
}
_NEGATIVE = {
    "难过": (-0.8, 0.5),
    "累": (-0.5, 0.3),
    "烦": (-0.6, 0.5),
    "生气": (-0.8, 0.7),
    "害怕": (-0.8, 0.8),
    "焦虑": (-0.7, 0.7),
    "紧张": (-0.6, 0.7),
    "痛": (-0.7, 0.6),
    "失望": (-0.7, 0.4),
    "孤独": (-0.7, 0.4),
    "委屈": (-0.7, 0.5),
    "担心": (-0.5, 0.6),
    "崩溃": (-0.9, 0.9),
    "讨厌": (-0.7, 0.5),
    "糟": (-0.6, 0.5),
}


def detect_emotion(text: str) -> EmotionTag:
    """按词表命中计数；正负都有时取差值，强度按命中次数收敛。"""
    body = text or ""
    positive = sum(value for word, (value, _) in _POSITIVE.items() if word in body)
    negative = sum(value for word, (value, _) in _NEGATIVE.items() if word in body)
    arousal_p = sum(arousal for word, (_, arousal) in _POSITIVE.items() if word in body)
    arousal_n = sum(arousal for word, (_, arousal) in _NEGATIVE.items() if word in body)
    raw = positive + negative
    if raw == 0:
        return EmotionTag()
    count = max(1, sum(1 for word in (*_POSITIVE, *_NEGATIVE) if word in body))
    valence = max(-1.0, min(1.0, raw / count))
    arousal = min(1.0, (arousal_p + arousal_n) / count)
    label = "positive" if valence > 0.1 else "negative" if valence < -0.1 else "neutral"
    return EmotionTag(valence=valence, arousal=arousal, label=label)


def mood_valence(text: str) -> float:
    """把角色状态里的心情词映射成效价，供情绪一致性回忆使用。"""
    return detect_emotion(text).valence
