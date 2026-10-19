"""文件职责：模型供给层的连通性探测——「测试连接」唯一的出网点（需求 §6.13 / T1.14b）。

为什么单独一个适配器：探测是「和外部世界说话」，属于适配器层；services 只负责编排、把结果
翻成契约模型。三条探测路径都**只回结论、不回密钥**：api_key 绝不进 detail，也绝不进日志。

谁会看结论：设置窗的「测试连接」按钮（每个候选端点一行，成功/失败 + 简短原因 + 耗时）。
超时口径：按钮后面站着用户，所以单次最多 5s（PROBE_TIMEOUT_S），连接阶段 3s。

谁调用：services/provider_test_service.py 注入使用；tests/test_provider_probe.py 用
httpx.MockTransport 覆盖 200 / HTTP 错误 / 超时 / 连不上四条路径，不联网。
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from adapters.asr_openai import pcm16_to_wav
from adapters.llm_openai import chat_completions_url

#: 探测单次最多等多久；比正式请求的总预算短得多——用户按着按钮在等。
PROBE_TIMEOUT_S = 5.0
CONNECT_TIMEOUT_S = 3.0

#: 出错时只留响应体前这么多字符，避免把整篇 HTML 错误页塞进界面。
_BODY_PREVIEW_CHARS = 160

#: 探测用的最小请求：一句话、最多一个 token（有些端点不接受 max_tokens=0）。
_PROBE_PROMPT = "ping"

#: edge 音色名形如 zh-CN-XiaoxiaoNeural（与 adapters/tts_edge.py 的判别一致）。
_EDGE_VOICE_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$")
#: 云端 ASR 探测用的静音时长（秒）：0.1s 足够让端点走完「收文件 → 返回文本」的路径。
_PROBE_SILENCE_S = 0.1


@dataclass(frozen=True, slots=True)
class ProbeOutcome:
    """一次探测的结论；detail 是给人看的短句，不含密钥。"""

    ok: bool
    detail: str
    elapsed_ms: int


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.perf_counter() - started) * 1000))


def _preview(text: str) -> str:
    """响应体预览：压掉换行、截断，空体给一句人话。"""
    flat = " ".join(text.split())
    if flat == "":
        return "（空响应体）"
    return flat[:_BODY_PREVIEW_CHARS]


async def probe_llm_endpoint(
    base_url: str,
    api_key: str,
    model: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout_s: float = PROBE_TIMEOUT_S,
) -> ProbeOutcome:
    """探测一个 OpenAI 兼容端点：POST 最小 chat/completions，看它是否按格式回话。

    transport 只给测试注入（httpx.MockTransport）；生产路径永远是 None。
    """
    started = time.perf_counter()
    url = chat_completions_url(base_url)
    payload: dict[str, object] = {
        "model": model,
        "messages": [{"role": "user", "content": _PROBE_PROMPT}],
        "max_tokens": 1,
        "stream": False,
    }
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    timeout = httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
            response = await client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        return ProbeOutcome(False, "请求超时（" + type(exc).__name__ + "）", _elapsed_ms(started))
    except httpx.HTTPError as exc:
        return ProbeOutcome(False, "连不上（" + type(exc).__name__ + "）", _elapsed_ms(started))
    elapsed = _elapsed_ms(started)
    if response.status_code != 200:
        detail = "HTTP " + str(response.status_code) + "：" + _preview(response.text)
        return ProbeOutcome(False, detail, elapsed)
    try:
        body = json.loads(response.text)
    except ValueError:
        return ProbeOutcome(False, "响应不是 JSON：" + _preview(response.text), elapsed)
    if not isinstance(body, dict) or "choices" not in body:
        detail = "响应不是 OpenAI 兼容格式（缺 choices）：" + _preview(response.text)
        return ProbeOutcome(False, detail, elapsed)
    return ProbeOutcome(True, "HTTP 200，OpenAI 兼容响应", elapsed)


async def probe_tts_adapter(
    base_url: str,
    token: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout_s: float = PROBE_TIMEOUT_S,
) -> ProbeOutcome:
    """探测常驻 TTS 适配器的 /health（§6.12）；只请求 GET /health，不触发加载模型。"""
    started = time.perf_counter()
    url = base_url.rstrip("/") + "/health"
    headers: dict[str, str] = {}
    if token:
        headers["X-Deskpet-Token"] = token
    timeout = httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
            response = await client.get(url, headers=headers)
    except httpx.TimeoutException as exc:
        return ProbeOutcome(False, "请求超时（" + type(exc).__name__ + "）", _elapsed_ms(started))
    except httpx.HTTPError as exc:
        return ProbeOutcome(False, "连不上（" + type(exc).__name__ + "）", _elapsed_ms(started))
    elapsed = _elapsed_ms(started)
    if response.status_code != 200:
        detail = "HTTP " + str(response.status_code) + "：" + _preview(response.text)
        return ProbeOutcome(False, detail, elapsed)
    try:
        body = json.loads(response.text)
    except ValueError:
        return ProbeOutcome(False, "响应不是 JSON：" + _preview(response.text), elapsed)
    ready = bool(body.get("ready")) if isinstance(body, dict) else False
    if ready:
        return ProbeOutcome(True, "适配器在线，模型已加载", elapsed)
    return ProbeOutcome(True, "适配器在线，模型尚未加载（首次合成时会加载）", elapsed)


def probe_asr_local(model: str, model_dir: Path) -> ProbeOutcome:
    """本地识别的「探测」：不联网、不加载模型，只看模型是不是已经落地。

    模型名既可以是本机路径，也可以是 faster-whisper 的模型名（首次识别时下载）。
    没有落地不算失败——它是合法配置，只是第一次识别会慢，且需要网络。
    """
    started = time.perf_counter()
    candidate = Path(model)
    if candidate.exists():
        return ProbeOutcome(True, "本地模型已就位：" + str(candidate), _elapsed_ms(started))
    detail = (
        "本地识别引擎无需端点；模型 " + model + " 尚未落地，首次识别时会下载到 " + str(model_dir)
    )
    return ProbeOutcome(True, detail, _elapsed_ms(started))


async def probe_asr_cloud(
    base_url: str,
    api_key: str,
    model: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout_s: float = PROBE_TIMEOUT_S,
) -> ProbeOutcome:
    """探测 OpenAI 兼容的云端转录端点（T2.4）：POST 一小段静音 wav，看它是否按格式回话。

    为什么真的发一次请求：这个按钮就是要回答「我这个端点 + 密钥到底能不能用」；
    只查 /models 会在某些兼容实现上给出假阳性。静音返回空文本也是成功（HTTP 200 即算通）。
    transport 只给测试注入（httpx.MockTransport）；生产路径永远是 None。
    """
    started = time.perf_counter()
    url = base_url.rstrip("/") + "/audio/transcriptions"
    sample_rate = 16000
    silence = pcm16_to_wav(b"\x00\x00" * int(sample_rate * _PROBE_SILENCE_S), sample_rate)
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    files = {"file": ("probe.wav", silence, "audio/wav")}
    timeout = httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
            response = await client.post(url, data={"model": model}, files=files, headers=headers)
    except httpx.TimeoutException as exc:
        return ProbeOutcome(False, "请求超时（" + type(exc).__name__ + "）", _elapsed_ms(started))
    except httpx.HTTPError as exc:
        return ProbeOutcome(False, "连不上（" + type(exc).__name__ + "）", _elapsed_ms(started))
    elapsed = _elapsed_ms(started)
    if response.status_code != 200:
        detail = "HTTP " + str(response.status_code) + "：" + _preview(response.text)
        return ProbeOutcome(False, detail, elapsed)
    return ProbeOutcome(True, "HTTP 200，转录端点可用", elapsed)


def probe_tts_edge(voice: str) -> ProbeOutcome:
    """探测 edge-tts（T2.4）：不联网、不合成，只看库装没装、音色名像不像 edge 音色。

    为什么不真的合成一句：合成要联网且要几百毫秒，这个按钮不该为「库在不在」付这个代价；
    真连不上微软服务时，第一次合成会照常报 DP-TTS 错误（§6.7）。
    """
    started = time.perf_counter()
    try:
        import edge_tts  # noqa: F401 —— 只检查可导入
    except ImportError:
        return ProbeOutcome(
            False,
            "edge-tts 未安装：pip install edge-tts（或用本地 IndexTTS）",
            _elapsed_ms(started),
        )
    if not _EDGE_VOICE_RE.fullmatch(voice):
        return ProbeOutcome(False, "音色名不像 edge 音色：" + voice, _elapsed_ms(started))
    return ProbeOutcome(True, "edge-tts 已安装，音色 " + voice, _elapsed_ms(started))
