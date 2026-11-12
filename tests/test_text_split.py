"""文件职责：单测 core/text.py 的切句规则（需求 §3.5 / §6.2 的 40 字硬上限）。

依赖方向：tests -> core（纯函数）；不需要网络、模型或音频。
谁调用：pytest。

为什么值得穷举：切句是「引擎吞字」的最后一道保险，规则一旦漂移，
症状是语音里偶尔少半句话，几乎不可能在现场复现。
"""

import pytest

from core.text import MIN_SOFT_CUT_RATIO, split_sentences


def test_sentence_end_punctuation_cuts_immediately() -> None:
    """句末标点就地断句，并保留标点（朗读需要语气）。"""
    assert split_sentences("你好。今天天气不错！") == ["你好。", "今天天气不错！"]


def test_newline_is_a_sentence_end() -> None:
    """换行也算句末：模型一行一句时不该被拼成超长句。"""
    assert split_sentences("第一行\n第二行") == ["第一行", "第二行"]


def test_carriage_return_is_ignored() -> None:
    """Windows 风格的 \r\n 不能切出空句子。"""
    assert split_sentences("第一行\r\n第二行") == ["第一行", "第二行"]


def test_blank_pieces_are_dropped() -> None:
    assert split_sentences("  \n\n  ") == []
    assert split_sentences("你好。\n\n。") == ["你好。", "。"]


def test_long_text_without_punctuation_is_hard_cut() -> None:
    """没有标点也没有软断点时必须硬切，且不超过上限——宁可切得难看，也不能让引擎吞字。"""
    text = "字" * 60
    pieces = split_sentences(text)
    assert len(pieces) >= 2
    assert all(len(piece) <= 40 for piece in pieces)
    assert "".join(pieces) == text


def test_soft_break_is_preferred_when_hard_cutting() -> None:
    """硬切时优先退到软断点之后，避免把短语劈成两半。"""
    text = "啊" * 39 + "，" + "呀" * 30
    pieces = split_sentences(text)
    assert pieces[0] == "啊" * 39 + "，"
    assert "".join(pieces) == text


def test_soft_break_before_ratio_floor_is_ignored() -> None:
    """太靠前的软断点不用（否则会切出「嗯，」这种碎句），改为硬切。"""
    text = "嗯，" + "啊" * 60
    pieces = split_sentences(text)
    assert pieces[0] == text[:40]
    assert len(pieces[0]) == 40


def test_custom_max_chars_is_honoured() -> None:
    assert split_sentences("abcdef", max_chars=3) == ["abc", "def"]


def test_non_positive_max_chars_is_rejected() -> None:
    """阈值写错必须立刻炸，而不是悄悄退化成不切句。"""
    with pytest.raises(ValueError):
        split_sentences("你好", max_chars=0)


def test_mixed_text_never_exceeds_limit() -> None:
    """混合中英文标点与空白的长文本，输出必须每句都在上限内。"""
    text = "今天有点累，想早点睡。" * 8 + "好的。" + "ok, let us go home now. " * 4
    pieces = split_sentences(text)
    assert all(len(piece) <= 40 for piece in pieces)
    assert MIN_SOFT_CUT_RATIO == 0.5
