"""文件职责：ASR 结果类型与「这句话值不值得往下传」的判定规则（需求 §5 F2 / §6.7）。

依赖方向：core 只依赖标准库（本模块连 contracts 都不用）；不 import adapters / api / services。
谁调用：adapters/asr_faster_whisper.py 产出 Transcript；
services/asr_service.py 调 is_meaningful_transcript。
为什么单独一个模块：faster-whisper 在静音、噪声、纯音乐上会稳定地「幻听」出字幕组署名与致谢语，
这些文本一旦原样喂给 LLM，角色就会对着沉默的用户念「谢谢观看」。规则必须能单测，
所以从适配器里抽出来——适配器要真模型才能跑，规则在这里不需要任何模型、任何音频。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: 低于这个时长当作「没有有效语音」：0.25s 以内的片段 whisper 仍可能吐出一整句幻听
MIN_SPEECH_DURATION_S = 0.25
#: 每秒最多可出现的字符数：正常语速约 4–7 字/秒，12 已不可能是人声——超过即判定为幻听
MAX_CHARS_PER_SECOND = 12.0
#: 同一个短单元连续重复这么多次，判定为复读噪声（「嗯嗯嗯嗯」）
MAX_REPEAT_RUN = 4

#: 幻听黑名单：都是「不会出现在真实对话里、却经常出现在 whisper 静音输出里」的串
HALLUCINATION_PATTERNS: tuple[str, ...] = (
    "字幕",
    "字幕组",
    "字幕志愿者",
    "谢谢观看",
    "谢谢大家观看",
    "感谢观看",
    "请不吝点赞",
    "点赞订阅",
    "订阅转发",
    "打赏",
    "subtitle",
    "subtitles",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "transcribed by",
    "amara.org",
)

_WHITESPACE_RE = re.compile(r"\s+")
_PUNCT_ONLY_RE = re.compile(r"^[\s\W_]+$")


@dataclass(frozen=True, slots=True)
class Transcript:
    """适配器返回的识别结果（内部类型；对外形状见 contracts/api_models.AsrResponse）。"""

    text: str
    confidence: float
    duration_s: float
    language: str | None = None


def normalize_transcript(text: str) -> str:
    """压掉多余空白；不做大小写变换（只判不改，原文可能含专有名词）。"""
    return _WHITESPACE_RE.sub(" ", text).strip()


def _is_repetitive(text: str) -> bool:
    """整句是否只是同一个短单元在复读（「嗯嗯嗯嗯」「哈哈哈哈」这类噪声）。"""
    for size in (1, 2, 3, 4):
        unit = text[:size]
        if not unit or len(text) < size * MAX_REPEAT_RUN:
            continue
        repeats = 0
        index = 0
        while text[index : index + size] == unit:
            repeats += 1
            index += size
        if repeats >= MAX_REPEAT_RUN and index == len(text):
            return True
    return False


def is_meaningful_transcript(text: str, *, duration_s: float) -> bool:
    """文本是否值得传给 LLM；False = 上层按「没听清，再说一次」处理（§6.7）。

    判定顺序按「代价从低到高」排：空 → 太短 → 语速不可能 → 只有标点 → 黑名单 → 复读。
    每一条都对应一种真实见过的幻听，能在测试里逐条复现（tests/test_asr_rules.py）。
    """
    normalized = normalize_transcript(text)
    if not normalized:
        return False
    if duration_s < MIN_SPEECH_DURATION_S:
        return False
    if duration_s > 0 and len(normalized) / duration_s > MAX_CHARS_PER_SECOND:
        # 幻听的典型特征：半秒噪声换来一整句字
        return False
    if _PUNCT_ONLY_RE.match(normalized):
        return False
    lowered = normalized.lower()
    if any(pattern in lowered for pattern in HALLUCINATION_PATTERNS):
        return False
    return not _is_repetitive(normalized)
