"""文件职责：把模型输出切成 ≤40 字的句子（需求 §3.5 / §6.2）。

依赖方向：core -> contracts（只取 MAX_SENTENCE_CHARS）；不 import adapters / api。
谁调用：services/chat_service.py 解析模型输出时使用；单测见 tests/test_text_split.py。

为什么需要它：IndexTTS 单句超过 40 字会吞字（§3.5 实测），而模型并不总是听话。
所以「切句」是服务层的硬保险——任何超长文本都必须在这里被切开，而不是指望提示词自觉。
切句规则刻意做成纯函数（不依赖网络与模型），这样它可以被穷举测试。
"""

from __future__ import annotations

from contracts.events import MAX_SENTENCE_CHARS

#: 句末标点：遇到它就地断句（保留标点，朗读时才有语气）。
SENTENCE_END_CHARS = frozenset("。！？!?…；;\n")

#: 软断点：必须硬切时优先退到这些字符之后，避免把词或短语劈成两半。
SOFT_BREAK_CHARS = frozenset("，,、：: 　")

#: 硬切时容忍的最小片段长度占比：太靠前的软断点不用（否则会切出「嗯，」这种碎句）。
MIN_SOFT_CUT_RATIO = 0.5


def _soft_cut_index(buffer: str, max_chars: int) -> int:
    """在 buffer 里选一个断点：优先最后的软断点，实在没有就硬切到 max_chars。"""
    floor = int(max_chars * MIN_SOFT_CUT_RATIO)
    for index in range(max_chars - 1, floor - 1, -1):
        if buffer[index] in SOFT_BREAK_CHARS:
            return index + 1
    return max_chars


def split_sentences(text: str, *, max_chars: int = MAX_SENTENCE_CHARS) -> list[str]:
    """把任意文本切成若干不超过 max_chars 的句子（空白片段被丢弃）。

    规则（按优先级）：
    1. 遇到句末标点就断句；
    2. 一行里长度到达 max_chars 就断，尽量退到软断点；
    3. 都没有就硬切——宁可切得难看，也不能让引擎吞字。
    """
    if max_chars < 1:
        raise ValueError("max_chars 必须为正整数：" + repr(max_chars))

    sentences: list[str] = []
    buffer = ""
    for char in text:
        if char == "\r":
            continue
        buffer += char
        if char in SENTENCE_END_CHARS:
            if buffer.strip():
                sentences.append(buffer.strip())
            buffer = ""
            continue
        if len(buffer) >= max_chars:
            cut = _soft_cut_index(buffer, max_chars)
            head, buffer = buffer[:cut], buffer[cut:]
            if head.strip():
                sentences.append(head.strip())

    tail = buffer.strip()
    if tail:
        sentences.append(tail)
    return sentences
