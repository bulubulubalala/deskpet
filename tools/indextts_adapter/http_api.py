r"""文件职责：HTTP 路由、鉴权与 JSON 信封（本适配器的对外边界）。

依赖方向：被 cli 使用；依赖 config / engine / errors / worker。
为什么单独一个文件：路由与错误码就是对外契约（需求 §6.12），契约测试直接打这些路径。
状态传递：handler 的 state 由 make_handler() 绑成子类属性，而不是改全局类属性——
这样同一个进程里能同时起两个适配器（测试用），互不串味。
"""

from __future__ import annotations

import json
import logging
import time
from http.server import BaseHTTPRequestHandler
from typing import Any, ClassVar

from tools.indextts_adapter.config import (
    DEFAULT_TIMEOUT_S,
    EMOTION_DIMS,
    MAX_BODY_BYTES,
    MAX_TEXT_CHARS,
    SUPPORTED_LANGS,
    TARGET_PEAK_DEFAULT,
)
from tools.indextts_adapter.engine import SynthEngine
from tools.indextts_adapter.errors import AdapterError, status_for
from tools.indextts_adapter.worker import SynthesisRequest, TtsWorker

__all__ = ["AdapterHandler", "AdapterState", "make_handler"]

LOG = logging.getLogger("deskpet.indextts_adapter.http")


class AdapterState:
    """handler 与 cli 共享的状态容器：引擎 + 队列 + 可选口令。"""

    def __init__(self, engine: SynthEngine, worker: TtsWorker, token: str = "") -> None:
        self.engine = engine
        self.worker = worker
        self.token = token


class AdapterHandler(BaseHTTPRequestHandler):
    """五个接口：GET /health、POST /load /tts /cancel /unload（需求 §6.12）。"""

    server_version = "deskpet-indextts/0.2"
    protocol_version = "HTTP/1.1"
    state: ClassVar[AdapterState]

    # ---------- 基础工具 ----------

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, headers: dict[str, str]) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise AdapterError("DP-TTS-400", "请求体为空")
        if length > MAX_BODY_BYTES:
            raise AdapterError("DP-TTS-400", "请求体过大")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdapterError("DP-TTS-400", f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(payload, dict):
            raise AdapterError("DP-TTS-400", "请求体必须是 JSON 对象")
        return payload

    def _check_token(self) -> None:
        token = self.state.token
        if token and self.headers.get("X-Deskpet-Token") != token:
            raise AdapterError("DP-TTS-401", "token 无效")

    def log_message(self, fmt: str, *args: Any) -> None:  # 覆盖默认 stderr 日志格式
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    # ---------- 路由 ----------

    def do_GET(self) -> None:
        """GET /health：**不加载模型**、不等队列，随时可答（T0.6 心跳的同款思路）。"""
        if self.path.split("?")[0] != "/health":
            self._send_json(404, {"code": "DP-TTS-404", "message": "未知路径"})
            return
        stats = self.state.worker.stats()
        self._send_json(
            200,
            {
                "status": "ok",
                "ready": self.state.engine.loaded,
                "model_loaded": self.state.engine.loaded,
                "load_ms": self.state.engine.load_ms,
                "sample_rate": self.state.engine.sample_rate,
                "queue": stats,
                "langs": list(SUPPORTED_LANGS),
            },
        )

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        try:
            if path == "/tts":
                self._handle_tts()
            elif path == "/cancel":
                self._check_token()
                payload = self._read_json()
                request_id = str(payload.get("request_id") or "")
                self._send_json(200, {"cancelled": self.state.worker.cancel(request_id)})
            elif path == "/load":
                self._check_token()
                self.state.engine.load()
                self._send_json(200, {"model_loaded": True, "load_ms": self.state.engine.load_ms})
            elif path == "/unload":
                self._check_token()
                self.state.engine.unload()
                self._send_json(200, {"model_loaded": False})
            else:
                self._send_json(404, {"code": "DP-TTS-404", "message": "未知路径"})
        except AdapterError as exc:
            self._send_json(status_for(exc.code), exc.to_dict())

    def _handle_tts(self) -> None:
        """POST /tts：校验 → 入队 → 等 worker → 回 wav 或错误码。"""
        self._check_token()
        payload = self._read_json()
        text = str(payload.get("text") or "").strip()
        if not text:
            raise AdapterError("DP-TTS-400", "text 不能为空")
        if len(text) > MAX_TEXT_CHARS:
            raise AdapterError(
                "DP-TTS-400",
                f"text 超过 {MAX_TEXT_CHARS} 字（当前 {len(text)}）",
                "调用方（LLM 事件协议 §6.2）应先切句再逐句合成",
            )
        lang = str(payload.get("lang") or "ZH").upper()
        if lang not in SUPPORTED_LANGS:
            raise AdapterError("DP-TTS-400", f"不支持的 lang：{lang}")
        emo_vector = payload.get("emo_vector")
        if emo_vector is not None:
            if not isinstance(emo_vector, list) or len(emo_vector) != EMOTION_DIMS:
                raise AdapterError("DP-TTS-400", f"emo_vector 必须是 {EMOTION_DIMS} 个数字")
            try:
                emo_vector = [float(x) for x in emo_vector]
            except (TypeError, ValueError) as exc:
                raise AdapterError("DP-TTS-400", "emo_vector 含非数字") from exc
        request_id = str(payload.get("request_id") or "") or time.strftime("%H%M%S")
        target_peak = float(payload.get("target_peak", TARGET_PEAK_DEFAULT))
        req = SynthesisRequest(
            request_id, text, str(payload.get("voice") or ""), lang, emo_vector, target_peak
        )
        self.state.worker.submit(req)
        if not req.done.wait(timeout=float(payload.get("timeout_s", DEFAULT_TIMEOUT_S))):
            raise AdapterError("DP-TTS-504", "合成超时", "引擎可能被其他进程占用显存")
        if req.error is not None:
            raise req.error
        headers = {
            "X-Deskpet-Request-Id": request_id,
            "X-Deskpet-Gen-Ms": str(req.meta.get("gen_ms", 0)),
            "X-Deskpet-Audio-Ms": str(req.meta.get("audio_ms", 0)),
            "X-Deskpet-Rtf": str(req.meta.get("rtf", 0)),
            "X-Deskpet-Voice": str(req.meta.get("voice", "")),
        }
        self._send_bytes(200, req.audio or b"", headers)


def make_handler(state: AdapterState) -> type[AdapterHandler]:
    """把 state 绑到一个 handler 子类上：不起全局状态，测试可并存多个实例。"""
    return type("BoundAdapterHandler", (AdapterHandler,), {"state": state})
