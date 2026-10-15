r"""deskpet 的 IndexTTS 常驻适配器（必须用 IndexTTS 自己的解释器运行）。

文件职责：
    把 IndexTTS-2.5 的进程内推理接口包成一个只监听本机的 HTTP 服务，供 deskpet 的
    sidecar 按「一次一句话」调用：GET /health、POST /load、POST /tts、POST /cancel、POST /unload。

依赖方向：
    sidecar --HTTP--> 本脚本 --进程内--> indextts.infer_v2_5.IndexTTS2
    本脚本只依赖 IndexTTS 自带的那份包（torch / soundfile / numpy），**不引入 deskpet 的任何模块**；
    它不安装、不修复、不升级 IndexTTS —— 需求 D14：引擎由用户自己维护，本项目只负责调用。

为什么必须常驻：
    IndexTTS2(...) 构造一次就要把全部权重读进显存。本机实测冷启动 100.6s（Windows 首次 + 系统在
    换页），热启动 17.7-18.3s（需求 §3.2）。每合成一句话就重启一次进程是 18s 级开销，不可接受；
    常驻之后每句只付推理时间。

启动示例（在仓库根，用 IndexTTS 自己的 venv）：
    D:\IndexTTS\.venv\Scripts\python.exe scripts\indextts_server.py --port 8742
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("deskpet.indextts_server")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8742
DEFAULT_MODEL_DIR = r"D:\IndexTTS\checkpoints"
DEFAULT_VOICE_DIR = r"D:\IndexTTS\voices"
SUPPORTED_LANGS = ("ZH", "EN", "JA", "AR", "ES")
# 情感向量顺序：喜, 怒, 哀, 惧, 厌恶, 低落, 惊喜, 平静（需求 §3.3，IndexTTS-2.5 固定 8 维）
EMOTION_DIMS = 8
# 单句上限：需求 §6.2 规定 LLM 每句不超过 40 字，超过 40 字 IndexTTS 会自己切块（段间 200ms 静音、
# 语调可能不连续），所以适配器直接拒绝，让调用方先切句。理由见 D:\IndexTTS\batch_tts.py 的 CHUNK_LIMIT。
MAX_TEXT_CHARS = 40
MAX_BODY_BYTES = 64 * 1024
MAX_QUEUE = 8
# 与 D:\IndexTTS\batch_tts.py 的默认值保持一致，保证同一套参考音得到同样的响度
TARGET_PEAK_DEFAULT = 0.891


class AdapterError(Exception):
    """适配器对外报错用的异常。code 直接用错误码表里的错误码（CODE_STYLE §6.1）。"""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def to_dict(self) -> dict[str, str]:
        body = {"code": self.code, "message": self.message}
        if self.hint:
            # hint 是给用户看的排查指引（D14：引擎坏了原样呈现，不猜原因、不替用户修）
            body["hint"] = self.hint
        return body


class SynthesisRequest:
    """一句话的合成请求，同时充当调用方与工作线程之间的小黑板。"""

    __slots__ = ("request_id", "text", "voice", "lang", "emo_vector", "target_peak", "state", "audio", "meta", "error", "done")

    def __init__(
        self,
        request_id: str,
        text: str,
        voice: str,
        lang: str,
        emo_vector: list[float] | None,
        target_peak: float,
    ) -> None:
        self.request_id = request_id
        self.text = text
        self.voice = voice
        self.lang = lang
        self.emo_vector = emo_vector
        self.target_peak = target_peak
        self.state = "queued"
        self.audio: bytes | None = None
        self.meta: dict[str, Any] = {}
        self.error: AdapterError | None = None
        self.done = threading.Event()


class IndexTtsEngine:
    """模型生命周期与推理。保证同一时刻只有一个推理在跑（IndexTTS 不是线程安全的）。"""

    def __init__(self, model_dir: Path, voice_dir: Path) -> None:
        self.model_dir = model_dir
        self.voice_dir = voice_dir
        self.load_ms: int | None = None
        self.sample_rate: int = 0
        self._model: Any = None
        self._lock = threading.RLock()
        self._last_used_at = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def resolve_voice(self, voice: str) -> Path:
        """把调用方给的声音名解析成参考音 wav 的绝对路径。"""
        candidate = Path(voice)
        if not candidate.is_absolute():
            candidate = self.voice_dir / voice
            if candidate.suffix.lower() != ".wav":
                candidate = candidate.with_suffix(".wav")
        if not candidate.is_file():
            raise AdapterError(
                "DP-TTS-400",
                f"参考音不存在：{candidate}",
                "检查角色包 voice.json 里的参考音，或把 wav 放进 IndexTTS 的 voices 目录",
            )
        return candidate

    def load(self) -> None:
        """按需加载模型。第一次调用会阻塞十几秒到上百秒，期间 /health 的 ready 为 false。"""
        with self._lock:
            if self._model is not None:
                return
            # 延迟 import：不合成就不需要把 torch 拉起来，方便先看 /health
            from indextts.infer_v2_5 import IndexTTS2

            cfg_path = self.model_dir / "config.yaml"
            if not cfg_path.is_file():
                raise AdapterError(
                    "DP-TTS-503",
                    f"找不到模型配置：{cfg_path}",
                    "确认 IndexTTS 的 checkpoints 目录完整",
                )
            started = time.perf_counter()
            # use_qwen_emo=False：情感由 LLM 给 8 维向量，不用 QwenEmotion（需求 D3）
            self._model = IndexTTS2(
                cfg_path=str(cfg_path),
                model_dir=str(self.model_dir),
                use_bf16=True,
                use_cuda_kernel=False,
                use_torch_compile=False,
                use_qwen_emo=False,
            )
            self.load_ms = int((time.perf_counter() - started) * 1000)
            self._last_used_at = time.time()
            LOG.info("model loaded in %.1fs", self.load_ms / 1000)

    def unload(self) -> None:
        """卸载我们自己加载的模型实例并尽量归还显存（需求 §4.4 推理资源闸门 / OOM 降级）。"""
        with self._lock:
            if self._model is None:
                return
            self._model = None
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # pragma: no cover - 卸载失败不影响正确性
                LOG.warning("empty_cache failed: %s", traceback.format_exc(limit=1))
            LOG.info("model unloaded")

    def synth(self, req: SynthesisRequest) -> tuple[bytes, dict[str, Any]]:
        """合成一句话，返回 (wav 字节, 统计信息)。全程持有锁，故天然串行。"""
        voice_path = self.resolve_voice(req.voice)
        with self._lock:
            self.load()
            started = time.perf_counter()
            out_dir = self.model_dir.parent / "_deskpet_tts_tmp"
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{req.request_id}.wav"
            kwargs: dict[str, Any] = {}
            if req.emo_vector is not None:
                kwargs["emo_vector"] = req.emo_vector
            try:
                self._model.infer(
                    spk_audio_prompt=str(voice_path),
                    text=req.text,
                    lang=req.lang,
                    output_path=str(out_path),
                    verbose=False,
                    **kwargs,
                )
                raw = out_path.read_bytes()
            finally:
                out_path.unlink(missing_ok=True)
            gen_ms = int((time.perf_counter() - started) * 1000)
            self._last_used_at = time.time()
        audio, sample_rate = _read_wav(raw)
        duration_s = len(audio) / sample_rate if sample_rate else 0.0
        if req.target_peak > 0 and duration_s > 0:
            audio = _peak_normalize(audio, req.target_peak)
            raw = _write_wav(audio, sample_rate)
        self.sample_rate = sample_rate
        meta = {
            "sample_rate": sample_rate,
            "audio_ms": int(duration_s * 1000),
            "gen_ms": gen_ms,
            "rtf": round(gen_ms / 1000 / duration_s, 3) if duration_s > 0 else 0.0,
            "voice": str(voice_path),
            "model_load_ms": self.load_ms,
        }
        return raw, meta


def _read_wav(raw: bytes) -> tuple[list[float], int]:
    """读 wav 以便做峰值归一化。soundfile/numpy 是 IndexTTS 自己的依赖，这里不额外要求安装。"""
    import soundfile as sf  # type: ignore[import-not-found]

    import numpy as np  # type: ignore[import-not-found]

    import io

    data, sample_rate = sf.read(io.BytesIO(raw), dtype="float32")
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    return np.asarray(data, dtype="float32"), int(sample_rate)


def _peak_normalize(audio: Any, target_peak: float) -> Any:
    import numpy as np  # type: ignore[import-not-found]

    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        return audio
    return (audio / peak * target_peak).astype("float32")


def _write_wav(audio: Any, sample_rate: int) -> bytes:
    import io

    import soundfile as sf  # type: ignore[import-not-found]

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class TtsWorker(threading.Thread):
    """单线程消费队列。IndexTTS 一次只能跑一个请求，队列让 /cancel 有机会丢掉还没开始的句子。"""

    def __init__(self, engine: IndexTtsEngine) -> None:
        super().__init__(name="tts-worker", daemon=True)
        self.engine = engine
        self._queue: queue.Queue[SynthesisRequest | None] = queue.Queue(maxsize=MAX_QUEUE)
        self._lock = threading.Lock()
        self._pending: list[SynthesisRequest] = []
        self._current: SynthesisRequest | None = None

    def submit(self, req: SynthesisRequest) -> None:
        with self._lock:
            if len(self._pending) >= MAX_QUEUE:
                raise AdapterError(
                    "DP-TTS-409",
                    "合成队列已满",
                    "上一句还在合成；调用方应保持「一次一句话」并在打断时先调 /cancel",
                )
            self._pending.append(req)
        try:
            self._queue.put_nowait(req)
        except queue.Full as exc:  # pragma: no cover - 与上面的长度检查重复，仅兜底
            with self._lock:
                self._pending.remove(req)
            raise AdapterError("DP-TTS-409", "合成队列已满") from exc

    def cancel(self, request_id: str) -> str:
        """返回 queued / in_flight / unknown。in_flight 只能标记，当前这句会跑完但结果被丢弃。"""
        with self._lock:
            for req in self._pending:
                if req.request_id == request_id and req.state == "queued":
                    req.state = "cancelled"
                    req.error = AdapterError("DP-TTS-499", "已取消")
                    req.done.set()
                    return "queued"
            if self._current is not None and self._current.request_id == request_id:
                # IndexTTS 的 infer() 没有中途取消的钩子（需求 D14 不改造引擎），
                # 所以这里只做标记：调用方应立刻停播放并丢弃结果，真正的中断发生在播放侧。
                self._current.state = "cancelling"
                return "in_flight"
        return "unknown"

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "pending": len(self._pending),
                "current": self._current.request_id if self._current else None,
            }

    def run(self) -> None:
        while True:
            req = self._queue.get()
            if req is None:
                return
            with self._lock:
                self._current = req
                if req in self._pending:
                    self._pending.remove(req)
            if req.state == "cancelled":
                with self._lock:
                    self._current = None
                continue
            req.state = "running"
            try:
                req.audio, req.meta = self.engine.synth(req)
                req.state = "done"
            except AdapterError as exc:
                req.error = exc
                req.state = "failed"
            except Exception as exc:  # 引擎内部异常：原样呈现，不猜原因（D14）
                LOG.error("synthesis failed: %s", traceback.format_exc(limit=3))
                req.error = AdapterError(
                    "DP-TTS-500",
                    f"{type(exc).__name__}: {exc}",
                    "查看 IndexTTS 侧日志；本应用不替用户安装、修复或重启引擎",
                )
                req.state = "failed"
            finally:
                req.done.set()
                with self._lock:
                    self._current = None


class AdapterState:
    """handler 与 main 共享的状态容器。"""

    def __init__(self, engine: IndexTtsEngine, worker: TtsWorker, token: str) -> None:
        self.engine = engine
        self.worker = worker
        self.token = token


class AdapterHandler(BaseHTTPRequestHandler):
    server_version = "deskpet-indextts/0.1"
    protocol_version = "HTTP/1.1"
    state: AdapterState

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

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 的命名约定
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

    def do_POST(self) -> None:  # noqa: N802
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
            self._send_json(_status_for(exc.code), exc.to_dict())

    def _handle_tts(self) -> None:
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
        req = SynthesisRequest(request_id, text, str(payload.get("voice") or ""), lang, emo_vector, target_peak)
        self.state.worker.submit(req)
        if not req.done.wait(timeout=float(payload.get("timeout_s", 120))):
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


def _status_for(code: str) -> int:
    """错误码最后三位就是 HTTP 状态码（CODE_STYLE §6.1）。"""
    try:
        return int(code.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 500


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="deskpet 的 IndexTTS 常驻 HTTP 适配器")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认只听本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    parser.add_argument("--voice-dir", default=DEFAULT_VOICE_DIR)
    parser.add_argument("--token", default=os.environ.get("DESKPET_TTS_TOKEN", ""), help="可选：与 sidecar 共享的口令")
    parser.add_argument("--preload", action="store_true", help="启动时就把模型读进来（否则第一句要多等一次加载）")
    parser.add_argument("--log-level", default="info")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    engine = IndexTtsEngine(Path(args.model_dir), Path(args.voice_dir))
    worker = TtsWorker(engine)
    worker.start()
    AdapterHandler.state = AdapterState(engine, worker, args.token)
    if args.preload:
        try:
            engine.load()
        except AdapterError as exc:
            LOG.error("preload failed: %s", exc.message)
    server = ThreadingHTTPServer((args.host, args.port), AdapterHandler)
    LOG.info("listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
