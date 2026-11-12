"""文件职责：记忆向量的二进制编解码与余弦相似度（不碰数据库）。"""

from __future__ import annotations

import array
import math
from collections.abc import Sequence


def _encode_vector(vector: Sequence[float]) -> bytes:
    return array.array("f", (float(v) for v in vector)).tobytes()


def _decode_vector(blob: bytes) -> list[float]:
    values = array.array("f")
    values.frombytes(blob)
    return list(values)


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        return -1.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=False):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return -1.0
    return dot / (math.sqrt(na) * math.sqrt(nb))
