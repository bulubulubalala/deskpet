"""文件职责：ASR 幻听判定规则的逐条测试（core/asr.py，需求 §6.7 / §5 F2）。

为什么单测这一层：这些规则决定「什么话会被当成没听清」，而 faster-whisper 在静音与噪声上
会稳定地幻听出字幕组署名与致谢语。规则一旦放松，角色就会对着沉默的用户念「谢谢观看」；
一旦收紧过头，正常说一句话也会被丢掉。每条规则都对应一种真实见过的输出，所以逐条断言。
"""

from __future__ import annotations

from core.asr import is_meaningful_transcript, normalize_transcript


def test_normalize_collapses_whitespace_and_strips() -> None:
    assert normalize_transcript("  你  好\n世界 ") == "你 好 世界"


def test_blank_text_is_not_meaningful() -> None:
    assert not is_meaningful_transcript("   ", duration_s=3.0)


def test_too_short_recording_is_not_meaningful() -> None:
    """0.25s 以内仍可能吐出一整句幻听，直接丢掉。"""
    assert not is_meaningful_transcript("你好", duration_s=0.24)


def test_boundary_duration_is_accepted() -> None:
    assert is_meaningful_transcript("你好呀", duration_s=0.25)


def test_impossible_speech_rate_is_not_meaningful() -> None:
    """半秒噪声换来一整句字：按语速判定为幻听。"""
    assert not is_meaningful_transcript("今天天气不错我想出门走走", duration_s=0.5)


def test_boundary_speech_rate_is_accepted() -> None:
    """正好 12 字/秒（阈值边界）仍按人声处理。"""
    assert is_meaningful_transcript("今天天气不错我想出门走走", duration_s=1.0)


def test_punctuation_only_is_not_meaningful() -> None:
    assert not is_meaningful_transcript("。。。！？", duration_s=2.0)


def test_hallucination_blacklist_is_rejected() -> None:
    """字幕组署名与致谢语是静音幻听的高频输出。"""
    assert not is_meaningful_transcript("谢谢观看", duration_s=2.0)
    assert not is_meaningful_transcript("请不吝点赞订阅", duration_s=2.0)
    assert not is_meaningful_transcript("Subtitles by Amara.org", duration_s=2.0)


def test_blacklist_is_case_insensitive() -> None:
    assert not is_meaningful_transcript("Thanks For Watching", duration_s=2.0)


def test_repeated_noise_is_not_meaningful() -> None:
    assert not is_meaningful_transcript("好的好的好的好的", duration_s=2.0)


def test_repetition_must_cover_whole_text() -> None:
    """部分重复不算复读：真实对话里也会连说两个短词。"""
    assert is_meaningful_transcript("好的好的，那我们出发吧", duration_s=2.0)


def test_normal_sentence_is_meaningful() -> None:
    assert is_meaningful_transcript("今天天气不错，我们出去走走？", duration_s=3.0)
