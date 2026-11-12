r"""文件职责：适配器的全部常量与命令行参数。

依赖方向：只被 cli / http_api / worker 导入，不依赖本包其他模块。
为什么集中在这里：CODE_STYLE §1.6 禁止魔法数字——阈值必须命名并注明出处（需求 §6.12）。
"""

from __future__ import annotations

import argparse
import os

__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_MODEL_DIR",
    "DEFAULT_PORT",
    "DEFAULT_TIMEOUT_S",
    "DEFAULT_VOICE_DIR",
    "EMOTION_DIMS",
    "MAX_BODY_BYTES",
    "MAX_QUEUE",
    "MAX_TEXT_CHARS",
    "SUPPORTED_LANGS",
    "TARGET_PEAK_DEFAULT",
    "build_parser",
]

# 默认只听本机：适配器没有任何鉴权强度可言，绝不对外暴露（需求 §6.12）
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8742  # 需求 §6.12 定下的端口，sidecar 侧按它连接
DEFAULT_MODEL_DIR = r"D:\IndexTTS\checkpoints"
DEFAULT_VOICE_DIR = r"D:\IndexTTS\voices"
SUPPORTED_LANGS = ("ZH", "EN", "JA", "AR", "ES")
# 情感向量顺序：喜, 怒, 哀, 惧, 厌恶, 低落, 惊喜, 平静（需求 §3.3，IndexTTS-2.5 固定 8 维）
EMOTION_DIMS = 8
# 单句上限：需求 §6.2 规定 LLM 每句不超过 40 字；超了 IndexTTS 会自己切块（段间 200ms 静音、
# 语调可能不连续），所以适配器直接拒绝，让调用方先切句（见 batch_tts.py 的 CHUNK_LIMIT）
MAX_TEXT_CHARS = 40
MAX_BODY_BYTES = 64 * 1024  # 一句话的 JSON 撑死几 KB，超了说明调用方有问题
MAX_QUEUE = 8  # 队列上限：调用方应保持「一次一句话」，排队只是给打断留出取消窗口
# 与 D:\IndexTTS\batch_tts.py 的默认值保持一致，保证同一套参考音得到同样的响度
TARGET_PEAK_DEFAULT = 0.891
DEFAULT_TIMEOUT_S = 120


def build_parser() -> argparse.ArgumentParser:
    """命令行参数。默认值全部来自本模块常量，便于 sidecar 侧对齐。"""
    parser = argparse.ArgumentParser(description="deskpet 的 IndexTTS 常驻 HTTP 适配器")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认只听本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    parser.add_argument("--voice-dir", default=DEFAULT_VOICE_DIR)
    parser.add_argument(
        "--token",
        default=os.environ.get("DESKPET_TTS_TOKEN", ""),
        help="可选：与 sidecar 共享的口令",
    )
    parser.add_argument(
        "--preload", action="store_true", help="启动时就把模型读进来（否则第一句要多等一次加载）"
    )
    parser.add_argument("--log-level", default="info")
    return parser
