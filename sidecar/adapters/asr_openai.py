"""文件职责：OpenAI 兼容的云端语音识别适配器——ASR provider = cloud 的唯一出口（T2.4）。

依赖方向：adapters -> contracts / core；不 import services / api。
谁调用：services/asr_service.py 的 build_asr_service 按 provider 注入；单测用 httpx.MockTransport。

为什么是「OpenAI 兼容」而不是某一家：Groq、OpenAI、Azure 兼容口都提供
`POST {base_url}/audio/transcriptions` 的多段表单接口（file + model + 可选 language），
本项目只认这一个形状，换供应商只改 .env 的 base_url / model / api_key。

不依赖 ffmpeg（§3.4）：渲染层送来的是 16-bit 小端单声道裸 PCM，这里自己拼 44 字节的 WAV 头
再上传——云端几乎都接受 wav，不需要引入解码器。

加载语义：云端没有「加载模型」这一步，is_loaded 恒 True、load / unload 是空操作，
这样它和本地适配器对 services/asr_service.py 暴露同一套接口。
"""

from __future__ import annotations

import json
import struct
import time
from dataclasses import dataclass

import httpx

from contracts.errors import CODE_ASR_TIMEOUT, CODE_ASR_UNAVAILABLE
from core.asr import Transcript, normalize_transcript
from core.errors import AsrError
from core.logging import get_logger

LOGGER = get_logger("sidecar.adapters.asr_openai")

#: 建连单独收紧：端点连不上要立刻报错，而不是陪用户等满整个识别预算。
CONNECT_TIMEOUT_S = 5.0
#: 出错时只留响应体前这么多字符（云端错误页往往很长）。
_BODY_PREVIEW_CHARS = 200
PCM_SAMPLE_WIDTH_BYTES = 2

USER_HINT_ASR_CLOUD_DOWN = "云端识别连不上：检查端点地址 / 密钥，或把来源改回本地。"
USER_HINT_ASR_CLOUD_ERROR = "云端识别出错了，这句话先跳过。"


@dataclass(frozen=True, slots=True)
class OpenAiAsrEndpoint:
    """云端转录端点（OpenAI 兼容）。api_key 可空（走本地兼容服务时不需要）。"""

    base_url: str
    api_key: str
    model: str
    timeout_s: float


def pcm16_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """把 16-bit 小端单声道裸 PCM 包成 44 字节头的 WAV（不依赖 ffmpeg）。"""
    channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,  # fmt 块长度
        1,  # PCM 编码
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm


class OpenAiAsr:
    """按 OpenAI 兼容接口做云端识别；失败抛 AsrError（错误码域归 ASR，§6.4）。"""

    def __init__(
        self,
        endpoint: OpenAiAsrEndpoint,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint
        # transport 只给测试注入（httpx.MockTransport）；生产路径永远是 None
        self._transport = transport

    @property
    def is_loaded(self) -> bool:
        """云端无本地模型可加载：永远「已就绪」。"""
        return True

    def load(self) -> None:
        """空操作：适配器接口对齐用（本地适配器要加载 464MB 模型，云端不用）。"""

    def unload(self) -> None:
        """空操作：云端没有可卸载的本地资源。"""

    async def transcribe(
        self, pcm: bytes, *, sample_rate: int, lang: str | None = None
    ) -> Transcript:
        """上传一段 PCM → 文本；网络 / HTTP / 解析失败都翻成带指引的 AsrError。"""
        if not self._endpoint.base_url:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "云端识别未配置端点（DESKPET_ASR_CLOUD_BASE_URL 为空）",
                user_hint=(
                    "请填云端 base_url / model / api_key，或把 DESKPET_ASR_PROVIDER 改回 local。"
                ),
            )
        wav = pcm16_to_wav(pcm, sample_rate)
        url = self._endpoint.base_url.rstrip("/") + "/audio/transcriptions"
        data: dict[str, str] = {"model": self._endpoint.model}
        if lang:
            data["language"] = lang
        headers = {"Accept": "application/json"}
        if self._endpoint.api_key:
            headers["Authorization"] = "Bearer " + self._endpoint.api_key
        files = {"file": ("audio.wav", wav, "audio/wav")}
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                timeout=httpx.Timeout(self._endpoint.timeout_s, connect=CONNECT_TIMEOUT_S),
            ) as client:
                response = await client.post(url, data=data, files=files, headers=headers)
        except httpx.TimeoutException as exc:
            raise AsrError(
                CODE_ASR_TIMEOUT,
                "云端识别请求超时（" + type(exc).__name__ + "）",
                user_hint=USER_HINT_ASR_CLOUD_ERROR,
                context={"url": url},
            ) from exc
        except httpx.HTTPError as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "连不上云端识别（" + type(exc).__name__ + "：" + str(exc) + "）",
                user_hint=USER_HINT_ASR_CLOUD_DOWN,
                context={"url": url},
            ) from exc
        if response.status_code != 200:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "云端识别返回 HTTP " + str(response.status_code) + "：" + _preview(response.text),
                user_hint=USER_HINT_ASR_CLOUD_ERROR,
                context={"url": url, "status": response.status_code},
            )
        try:
            body = json.loads(response.text)
        except ValueError as exc:
            raise AsrError(
                CODE_ASR_UNAVAILABLE,
                "云端识别响应不是 JSON：" + _preview(response.text),
                user_hint=USER_HINT_ASR_CLOUD_ERROR,
                context={"url": url},
            ) from exc
        text = normalize_transcript(str(_text_of(body)))
        elapsed_s = time.perf_counter() - started
        duration_s = len(pcm) / (sample_rate * PCM_SAMPLE_WIDTH_BYTES) if sample_rate > 0 else 0.0
        # 云端不逐句给置信度：有文本按 1.0，空文本按 0.0（上层再按「值不值得传」过滤）
        confidence = 1.0 if text else 0.0
        LOGGER.debug(
            "asr.cloud_transcribe",
            "云端识别完成",
            extra={"dp": {"chars": len(text), "elapsed_s": round(elapsed_s, 3)}},
        )
        return Transcript(text=text, confidence=confidence, duration_s=duration_s, language=lang)


def _text_of(body: object) -> str:
    """从响应体里取 text；不同兼容实现有的给 str 有的给 {text: ...}。"""
    if isinstance(body, dict):
        value = body.get("text")
        return value if isinstance(value, str) else ""
    return ""


def _preview(text: str) -> str:
    flat = " ".join(text.split())
    return flat[:_BODY_PREVIEW_CHARS] if flat else "（空响应体）"
