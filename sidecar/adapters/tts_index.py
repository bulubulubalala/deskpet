"""文件职责：IndexTTS 常驻适配器的 HTTP 客户端——/tts 与 /tts/cancel 的唯一出口（§6.3 / §6.12）。

依赖方向：adapters -> contracts / core；不 import services / api。
谁调用：services/tts_service.py 注入使用；单测用 httpx.MockTransport 喂假响应，不联网。

边界（D14）：本模块只负责「调用」。引擎没启动、报错、超时，都只把**引擎侧的原话**带出来，
再加一条排查指引；绝不尝试启动 / 重启 / 安装 / 调参——那是用户自己的事（需求 §2 D14）。

契约里保留但当前不透传的字段：TtsRequest 的 emo_weight / speed。§6.12 的适配器不接受
这两个旋钮（IndexTTS-2.5 的 infer 接口没暴露），传了会被静默忽略——与其假装生效，不如在这里
明确说明。要加必须同时改需求 §6.12 与适配器实现。

取消语义（§6.12）：/cancel 返回 queued / in_flight / unknown。真正 <200ms 的打断发生在
**播放侧**（T1.6）：这里只把取消请求发出去并如实回报状态，在途那句的算力照常付完。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import cast

import httpx

from contracts.api_models import TtsRequest
from contracts.errors import (
    CODE_TTS_ADAPTER_ERROR,
    CODE_TTS_NOT_AVAILABLE,
    CODE_TTS_SENTENCE_TIMEOUT,
)
from core.errors import TtsError
from core.logging import get_logger
from core.tts import CANCEL_STATES, CANCEL_UNKNOWN, TtsAudio, TtsHealth

LOGGER = get_logger("sidecar.adapters.tts_index")

#: 单句合成预算（需求 §6.7：TTS 单句超时 30s）；用例层还会再兜一层 wait_for
DEFAULT_TIMEOUT_S = 30.0
#: 建连预算单独收紧：引擎没启动时要立刻报错，而不是陪着等满 30s（§6.7「能自愈的别打扰用户，
#: 需要用户动手的必须马上说清楚」）
CONNECT_TIMEOUT_S = 5.0
#: 响应体只留前这么多字符进日志 / 错误上下文，避免把整段引擎日志倒进日志文件
_BODY_PREVIEW_CHARS = 200

USER_HINT_ENGINE_DOWN = "语音引擎没有在运行：请自行启动 IndexTTS 适配器（本项目只负责调用）"
USER_HINT_ENGINE_ERROR = "语音引擎出错了，这句话先跳过；具体原因见日志里的引擎侧信息"
USER_HINT_TIMEOUT = "等语音引擎太久了，这句话先跳过"


@dataclass(frozen=True, slots=True)
class TtsEndpoint:
    """适配器地址与可选口令（§6.12：默认只听 127.0.0.1:8742）。"""

    base_url: str
    token: str = ""
    timeout_s: float = DEFAULT_TIMEOUT_S


class IndexTtsClient:
    """按 §6.12 调适配器；每次请求新建 httpx.AsyncClient，用完即关（与 LLM 客户端同款）。"""

    def __init__(
        self,
        endpoint: TtsEndpoint,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint
        # transport 只给测试注入（httpx.MockTransport）；生产路径永远是 None
        self._transport = transport

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        """POST /tts → wav 字节 + 引擎侧性能头。失败一律抛 TtsError（§6.4）。"""
        payload: dict[str, object] = {
            "text": request.text,
            "voice": request.voice_id,
            "lang": request.lang.upper(),
            "emo_vector": list(request.emo_vector),
            "request_id": request.request_id,
            "timeout_s": self._endpoint.timeout_s,
        }
        response = await self._post("/tts", payload)
        return TtsAudio(
            audio=response.content,
            request_id=response.headers.get("X-Deskpet-Request-Id") or request.request_id,
            gen_ms=_int_header(response, "X-Deskpet-Gen-Ms"),
            audio_ms=_int_header(response, "X-Deskpet-Audio-Ms"),
            rtf=_float_header(response, "X-Deskpet-Rtf"),
            voice=response.headers.get("X-Deskpet-Voice") or request.voice_id,
        )

    async def cancel(self, request_id: str) -> str:
        """POST /cancel → queued / in_flight / unknown（§6.12；无法识别一律按 unknown）。"""
        response = await self._post("/cancel", {"request_id": request_id})
        state = str(_json_dict(response).get("cancelled") or CANCEL_UNKNOWN)
        return state if state in CANCEL_STATES else CANCEL_UNKNOWN

    async def load(self) -> int:
        """POST /load：预热模型，返回耗时毫秒（T1.8 资源闸门会用它显示「正在加载语音引擎」）。"""
        return _int_value(_json_dict(await self._post("/load", {})).get("load_ms"))

    async def unload(self) -> None:
        """POST /unload：卸载**我们自己加载的**模型实例并归还显存（§4.4）。"""
        await self._post("/unload", {})

    async def health(self) -> TtsHealth:
        """GET /health：不加载模型、随时可答（F9 与 T1.8 用它判断引擎在不在）。"""
        payload = _json_dict(await self._get("/health"))
        queue = payload.get("queue")
        queue_dict = queue if isinstance(queue, dict) else {}
        return TtsHealth(
            ready=bool(payload.get("ready")),
            model_loaded=bool(payload.get("model_loaded")),
            load_ms=_int_value(payload.get("load_ms")),
            sample_rate=_int_value(payload.get("sample_rate")),
            queue_pending=_int_value(queue_dict.get("pending")),
            queue_current=str(queue_dict.get("current") or "") or None,
        )

    # ---------- 内部工具 ----------

    def _url(self, path: str) -> str:
        return self._endpoint.base_url.rstrip("/") + path

    def _headers(self) -> dict[str, str]:
        if self._endpoint.token:
            return {"X-Deskpet-Token": self._endpoint.token}
        return {}

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self._endpoint.timeout_s, connect=CONNECT_TIMEOUT_S)

    async def _post(self, path: str, payload: dict[str, object]) -> httpx.Response:
        url = self._url(path)
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout()
            ) as client:
                response = await client.post(url, json=payload, headers=self._headers())
        except httpx.TimeoutException as exc:
            raise TtsError(
                CODE_TTS_SENTENCE_TIMEOUT,
                "语音引擎请求超时（" + type(exc).__name__ + "）",
                user_hint=USER_HINT_TIMEOUT,
                context={"url": url},
            ) from exc
        except httpx.HTTPError as exc:
            raise TtsError(
                CODE_TTS_NOT_AVAILABLE,
                "连不上语音引擎（" + type(exc).__name__ + "：" + str(exc) + "）",
                user_hint=USER_HINT_ENGINE_DOWN,
                context={"url": url},
            ) from exc
        if response.status_code != 200:
            raise self._http_error(response)
        return response

    async def _get(self, path: str) -> httpx.Response:
        url = self._url(path)
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout()
            ) as client:
                response = await client.get(url, headers=self._headers())
        except httpx.TimeoutException as exc:
            raise TtsError(
                CODE_TTS_SENTENCE_TIMEOUT,
                "语音引擎健康检查超时（" + type(exc).__name__ + "）",
                user_hint=USER_HINT_TIMEOUT,
                context={"url": url},
            ) from exc
        except httpx.HTTPError as exc:
            raise TtsError(
                CODE_TTS_NOT_AVAILABLE,
                "连不上语音引擎（" + type(exc).__name__ + "：" + str(exc) + "）",
                user_hint=USER_HINT_ENGINE_DOWN,
                context={"url": url},
            ) from exc
        if response.status_code != 200:
            raise self._http_error(response)
        return response

    def _http_error(self, response: httpx.Response) -> TtsError:
        """非 200：优先原样透传适配器的 {code,message,hint}（D14：引擎侧信息不加工）。"""
        status = response.status_code
        body = response.text[:_BODY_PREVIEW_CHARS]
        context: dict[str, object] = {
            "status": status,
            "body": body,
            "url": str(response.request.url),
        }
        parsed = _parse_envelope(response.text)
        if parsed is not None:
            code, message, hint = parsed
            if code.startswith("DP-TTS-"):
                return TtsError(
                    code, message, user_hint=hint or USER_HINT_ENGINE_ERROR, context=context
                )
            return TtsError(
                CODE_TTS_ADAPTER_ERROR,
                "语音引擎返回 " + code + "：" + message,
                user_hint=hint or USER_HINT_ENGINE_ERROR,
                context=context,
            )
        return TtsError(
            CODE_TTS_ADAPTER_ERROR,
            "语音引擎返回 HTTP " + str(status),
            user_hint=USER_HINT_ENGINE_ERROR,
            context=context,
        )


def _parse_envelope(text: str) -> tuple[str, str, str] | None:
    """解析适配器错误信封 {code,message,hint}；解析不出来返回 None。"""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    message = payload.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    hint = payload.get("hint")
    return code, message, hint if isinstance(hint, str) else ""


def _json_dict(response: httpx.Response) -> dict[str, object]:
    """响应体转 dict；不是 JSON 对象就返回空 dict（不抛，交给调用方按默认值处理）。"""
    try:
        payload = response.json()
    except ValueError:
        return {}
    return cast(dict[str, object], payload) if isinstance(payload, dict) else {}


def _int_value(raw: object) -> int:
    try:
        return int(cast(int, raw))
    except (TypeError, ValueError):
        return 0


def _int_header(response: httpx.Response, name: str) -> int:
    return _int_value(response.headers.get(name))


def _float_header(response: httpx.Response, name: str) -> float:
    raw = response.headers.get(name)
    try:
        return float(cast(str, raw))
    except (TypeError, ValueError):
        return 0.0


__all__ = [
    "CONNECT_TIMEOUT_S",
    "DEFAULT_TIMEOUT_S",
    "USER_HINT_ENGINE_DOWN",
    "USER_HINT_ENGINE_ERROR",
    "USER_HINT_TIMEOUT",
    "IndexTtsClient",
    "TtsEndpoint",
]
