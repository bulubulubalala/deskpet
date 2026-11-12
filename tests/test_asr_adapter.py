"""文件职责：faster-whisper 适配器的离线测试（假模型，不加载真模型、不碰麦克风）。

怎么做到无硬件可跑：适配器把「造模型」这件事收敛成一个可注入的 model_factory（CODE_STYLE §7），
这里的假模型只实现真正用到的 transcribe(audio, **kwargs)，返回 (分段, 信息)。
真模型只在 tests 之外的冒烟里跑——单测要能在没有 GPU、没有模型文件的机器上全绿。
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pytest

from adapters.asr_faster_whisper import (
    FasterWhisperAsr,
    decode_pcm16,
)
from config import AsrSettings
from contracts.errors import CODE_ASR_BAD_AUDIO, CODE_ASR_DEVICE_BUSY, CODE_ASR_UNAVAILABLE
from core.errors import AsrError


class FakeSegment:
    """假分段：只带适配器真正读取的四个字段。"""

    def __init__(self, text: str, avg_logprob: float, start: float, end: float) -> None:
        self.text = text
        self.avg_logprob = avg_logprob
        self.start = start
        self.end = end


class FakeInfo:
    """假识别信息：语言与总时长。"""

    def __init__(self, language: str | None = "zh", duration: float = 0.0) -> None:
        self.language = language
        self.duration = duration


class FakeModel:
    """假模型：回放固定分段，记录收到的参数；可配置成抛错。"""

    def __init__(
        self,
        segments: Iterable[FakeSegment] = (),
        info: FakeInfo | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.segments = list(segments)
        self.info = info or FakeInfo()
        self.error = error
        self.calls: list[dict[str, object]] = []

    def transcribe(self, audio: object, **kwargs: object) -> tuple[Iterable[FakeSegment], FakeInfo]:
        self.calls.append({"audio": audio, **kwargs})
        if self.error is not None:
            raise self.error
        return iter(self.segments), self.info


def _settings(**overrides: object) -> AsrSettings:
    values: dict[str, object] = {"model": "small", "language": "zh", "model_dir": Path("unused")}
    values.update(overrides)
    return AsrSettings(**values)  # type: ignore[arg-type]


def test_decode_pcm16_scales_int16_to_unit_range() -> None:
    """int16 满量程 32768 个刻度：0 -> 0.0，0x4000 -> 0.5。"""
    samples = decode_pcm16(b"\x00\x00\x00\x40")
    assert samples.dtype == np.float32
    assert np.allclose(samples, np.array([0.0, 0.5], dtype=np.float32))


def test_decode_pcm16_drops_half_a_sample() -> None:
    """奇数长度的尾巴（半个采样点）丢掉，而不是抛异常。"""
    assert decode_pcm16(b"\x00\x00\x01").size == 1


def test_adapter_is_lazy_and_reports_not_loaded() -> None:
    """构造适配器不许碰模型：心跳（§6.3）不能因为 ASR 冷启动而变慢。"""
    built: list[int] = []

    def factory(_settings: AsrSettings) -> FakeModel:
        built.append(1)
        return FakeModel()

    asr = FasterWhisperAsr(_settings(), model_factory=factory)
    assert asr.is_loaded is False
    assert built == []


def test_load_is_idempotent() -> None:
    built: list[int] = []

    def factory(_settings: AsrSettings) -> FakeModel:
        built.append(1)
        return FakeModel()

    asr = FasterWhisperAsr(_settings(), model_factory=factory)
    asr.load()
    asr.load()
    assert asr.is_loaded is True
    assert len(built) == 1


def test_unload_allows_reload() -> None:
    """T1.8 资源闸门要能空闲卸载，之后再用能重新加载（不能把引用留成死状态）。"""
    built: list[int] = []

    def factory(_settings: AsrSettings) -> FakeModel:
        built.append(1)
        return FakeModel()

    asr = FasterWhisperAsr(_settings(), model_factory=factory)
    asr.load()
    asr.unload()
    assert asr.is_loaded is False
    asr.load()
    assert len(built) == 2


@pytest.mark.asyncio
async def test_transcribe_joins_chinese_segments_and_weights_confidence() -> None:
    """中文分段直接拼接；置信度按分段时长加权。"""
    model = FakeModel(
        [
            FakeSegment(" 你好", 0.0, 0.0, 1.0),
            FakeSegment("世界。", -1.0, 1.0, 3.0),
        ],
        FakeInfo(language="zh"),
    )
    asr = FasterWhisperAsr(_settings(), model_factory=lambda _s: model)

    result = await asr.transcribe(b"\x00\x00" * 32000, sample_rate=16000)

    assert result.text == "你好世界。"
    assert result.language == "zh"
    assert result.duration_s == pytest.approx(3.0)
    expected = (1 * 1.0 + 2 * math.exp(-1.0)) / 3
    assert result.confidence == pytest.approx(expected, abs=1e-6)


@pytest.mark.asyncio
async def test_transcribe_spaces_non_chinese_segments() -> None:
    model = FakeModel([FakeSegment("hello", -0.1, 0.0, 1.0)], FakeInfo(language="en"))
    asr = FasterWhisperAsr(_settings(), model_factory=lambda _s: model)

    result = await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000)

    assert result.text == "hello"
    assert result.language == "en"


@pytest.mark.asyncio
async def test_transcribe_passes_settings_to_model() -> None:
    """beam_size / vad / 关闭上下文串联都要真的传下去，否则噪声会让模型自我引导。"""
    model = FakeModel([FakeSegment("你好", -0.1, 0.0, 1.0)])
    settings = _settings(beam_size=3, vad_filter=False, language="ja")
    asr = FasterWhisperAsr(settings, model_factory=lambda _s: model)

    await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000)

    (call,) = model.calls
    assert call["beam_size"] == 3
    assert call["vad_filter"] is False
    assert call["condition_on_previous_text"] is False
    assert call["language"] == "ja"


@pytest.mark.asyncio
async def test_request_language_overrides_settings() -> None:
    model = FakeModel([FakeSegment("你好", -0.1, 0.0, 1.0)])
    asr = FasterWhisperAsr(_settings(language="zh"), model_factory=lambda _s: model)

    await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000, lang="en")

    assert model.calls[0]["language"] == "en"


@pytest.mark.asyncio
async def test_empty_pcm_is_bad_audio_and_does_not_load_model() -> None:
    built: list[int] = []

    def factory(_settings: AsrSettings) -> FakeModel:
        built.append(1)
        return FakeModel()

    asr = FasterWhisperAsr(_settings(), model_factory=factory)

    with pytest.raises(AsrError) as caught:
        await asr.transcribe(b"", sample_rate=16000)

    assert caught.value.code == CODE_ASR_BAD_AUDIO
    assert built == []


@pytest.mark.asyncio
async def test_half_sample_pcm_is_bad_audio() -> None:
    asr = FasterWhisperAsr(_settings(), model_factory=lambda _s: FakeModel())

    with pytest.raises(AsrError) as caught:
        await asr.transcribe(b"\x01", sample_rate=16000)

    assert caught.value.code == CODE_ASR_BAD_AUDIO


@pytest.mark.asyncio
async def test_missing_package_is_translated_to_unavailable_with_hint() -> None:
    """缺 faster-whisper 不能只是崩：错误必须带可执行的排查指引（§6.7）。"""

    def factory(_settings: AsrSettings) -> FakeModel:
        raise ImportError("No module named 'faster_whisper'")

    asr = FasterWhisperAsr(_settings(), model_factory=factory)

    with pytest.raises(AsrError) as caught:
        await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000)

    assert caught.value.code == CODE_ASR_UNAVAILABLE
    assert "faster-whisper" in caught.value.user_hint


@pytest.mark.asyncio
async def test_model_download_failure_points_at_mirror() -> None:
    """首次下载失败是最常见的一种「装好了却用不了」，指引必须给出镜像开关。"""

    def factory(_settings: AsrSettings) -> FakeModel:
        raise OSError("Connection error")

    asr = FasterWhisperAsr(_settings(), model_factory=factory)

    with pytest.raises(AsrError) as caught:
        await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000)

    assert caught.value.code == CODE_ASR_UNAVAILABLE
    assert "hf-mirror" in caught.value.user_hint


@pytest.mark.asyncio
async def test_inference_failure_is_device_busy() -> None:
    model = FakeModel(error=RuntimeError("ctranslate2 炸了"))
    asr = FasterWhisperAsr(_settings(), model_factory=lambda _s: model)

    with pytest.raises(AsrError) as caught:
        await asr.transcribe(b"\x00\x00" * 16000, sample_rate=16000)

    assert caught.value.code == CODE_ASR_DEVICE_BUSY
