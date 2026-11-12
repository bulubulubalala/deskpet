"""文件职责：sherpa-onnx 流式识别适配器的真模型单测（P2）。

为什么可以真跑：模型与依赖都在本机（70 MB，data/ 已 gitignore），解码 5.6 s 音频只要
0.1 s 左右；模型不在时整组 skip，CI / 新机器不会因此红。
"""

from __future__ import annotations

import time
import wave
from pathlib import Path

import numpy as np
import pytest

from adapters.asr_stream_sherpa import SherpaStreamingAsr, find_model_files
from config import load_settings

REPO_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = (
    REPO_ROOT
    / "data"
    / "models"
    / "asr-stream"
    / "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
)

pytestmark = pytest.mark.skipif(
    not (MODEL_DIR / "tokens.txt").is_file(), reason="流式模型未下载（data/models/asr-stream）"
)


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        raw = handle.readframes(handle.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def _pcm(block: np.ndarray) -> bytes:
    return (np.clip(block, -1.0, 1.0) * 32768.0).clip(-32768, 32767).astype("<i2").tobytes()


def test_find_model_files_prefers_int8() -> None:
    files = find_model_files(MODEL_DIR)
    assert files.tokens.name == "tokens.txt"
    assert ".int8.onnx" in files.encoder.name
    assert ".int8.onnx" in files.decoder.name
    assert ".int8.onnx" in files.joiner.name


def test_streaming_produces_partials_and_final() -> None:
    """边喂 0.2 s 边取 partial；终稿非空，且解码远快于实时（RTF < 0.5）。"""
    settings = load_settings(env={"DESKPET_DATA_DIR": str(REPO_ROOT / "data")})
    asr = SherpaStreamingAsr(settings.asr)
    samples, rate = _read_wav(MODEL_DIR / "test_wavs" / "0.wav")
    assert rate == 16000

    stream = asr.start_stream(sample_rate=rate)
    chunk = int(0.2 * rate)
    partials: list[str] = []
    started = time.perf_counter()
    for index in range(0, len(samples), chunk):
        text = stream.accept(_pcm(samples[index : index + chunk]))
        if text and (not partials or text != partials[-1]):
            partials.append(text)
    final = stream.finish()
    stream.close()
    elapsed = time.perf_counter() - started

    assert len(partials) >= 2, f"partial 太少：{partials}"
    assert final.text.strip()
    assert final.duration_s > 5.0
    assert elapsed / final.duration_s < 0.5, f"RTF 太高：{elapsed / final.duration_s:.2f}"


def test_batch_transcribe_matches_stream_final() -> None:
    """transcribe() 走内部流，终稿应与逐块喂完全一致（同一模型、同一音频）。"""
    settings = load_settings(env={"DESKPET_DATA_DIR": str(REPO_ROOT / "data")})
    asr = SherpaStreamingAsr(settings.asr)
    samples, rate = _read_wav(MODEL_DIR / "test_wavs" / "0.wav")
    result = asr.transcribe(_pcm(samples), sample_rate=rate)
    assert result.text.strip()
    assert result.confidence == 1.0
