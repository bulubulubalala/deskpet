"""文件职责：轻量情绪标注测试（T2.39）。"""

from core.emotion import detect_emotion, mood_valence


def test_detect_emotion_positive_and_negative() -> None:
    positive = detect_emotion("今天面试很顺利，我很开心")
    assert positive.valence > 0.1
    assert positive.label == "positive"
    negative = detect_emotion("今天很累，也有点焦虑")
    assert negative.valence < -0.1
    assert negative.label == "negative"


def test_mood_valence_maps_character_mood() -> None:
    assert mood_valence("心里平平的，谈不上高兴也谈不上烦") > 0.0
    assert mood_valence("有点累，不太想说话") < 0.0
    assert mood_valence("平静") == 0.0
