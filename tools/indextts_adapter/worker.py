r"""文件职责：单线程合成队列，以及「取消」的语义。

依赖方向：被 http_api / cli 使用；依赖 engine（只为 SynthEngine 协议）与 errors。
为什么单独一个文件：排队与取消是这块最容易出竞态的地方，必须能脱离 HTTP 单独测。
取消语义（需求 §6.12）：
    排队中的句子 → 直接丢弃，调用方的 /tts 收到 DP-TTS-499；
    正在合成的句子 → 只能标记（IndexTTS 的 infer() 没有中途取消钩子，D14 不改造引擎），
    真正 <200ms 的打断由播放侧立刻停播 + 丢弃结果实现，在途那句的算力照常付完。
"""

from __future__ import annotations

import logging
import queue
import threading
import traceback
from typing import Any

from tools.indextts_adapter.config import MAX_QUEUE
from tools.indextts_adapter.engine import SynthEngine
from tools.indextts_adapter.errors import AdapterError

__all__ = ["SynthesisRequest", "TtsWorker"]

LOG = logging.getLogger("deskpet.indextts_adapter.worker")

STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_CANCELLED = "cancelled"
STATE_CANCELLING = "cancelling"
STATE_DONE = "done"
STATE_FAILED = "failed"


class SynthesisRequest:
    """一句话的合成请求，同时充当调用方与工作线程之间的小黑板（done 用来唤醒等待方）。"""

    __slots__ = (
        "audio",
        "done",
        "emo_vector",
        "error",
        "lang",
        "meta",
        "request_id",
        "state",
        "target_peak",
        "text",
        "voice",
    )

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
        self.state = STATE_QUEUED
        self.audio: bytes | None = None
        self.meta: dict[str, Any] = {}
        self.error: AdapterError | None = None
        self.done = threading.Event()


class TtsWorker(threading.Thread):
    """单线程消费队列。IndexTTS 一次只能跑一个请求，排队让 /cancel 有机会丢掉还没开始的句子。"""

    def __init__(self, engine: SynthEngine) -> None:
        super().__init__(name="tts-worker", daemon=True)
        self.engine = engine
        self._queue: queue.Queue[SynthesisRequest | None] = queue.Queue(maxsize=MAX_QUEUE)
        self._lock = threading.Lock()
        self._pending: list[SynthesisRequest] = []
        self._current: SynthesisRequest | None = None

    def submit(self, req: SynthesisRequest) -> None:
        """入队；队列满直接 DP-TTS-409，绝不阻塞 HTTP 线程（否则调用方会以为适配器死了）。"""
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
        """返回 queued / in_flight / unknown（语义见模块 docstring）。"""
        with self._lock:
            for req in self._pending:
                if req.request_id == request_id and req.state == STATE_QUEUED:
                    req.state = STATE_CANCELLED
                    req.error = AdapterError("DP-TTS-499", "已取消")
                    req.done.set()
                    return "queued"
            if self._current is not None and self._current.request_id == request_id:
                self._current.state = STATE_CANCELLING
                return "in_flight"
        return "unknown"

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "pending": len(self._pending),
                "current": self._current.request_id if self._current else None,
            }

    def stop(self) -> None:
        """给队列塞哨兵让线程退出（测试与优雅退出用）。"""
        try:
            self._queue.put_nowait(None)
        except queue.Full:  # pragma: no cover - 队列满时线程本来就会继续消费
            LOG.warning("stop(): queue full, worker keeps running")

    def run(self) -> None:
        while True:
            req = self._queue.get()
            if req is None:
                return
            with self._lock:
                self._current = req
                if req in self._pending:
                    self._pending.remove(req)
            if req.state == STATE_CANCELLED:
                # 排队期间被取消：不浪费算力，直接跳过（调用方已经在 done 上被唤醒）
                with self._lock:
                    self._current = None
                continue
            req.state = STATE_RUNNING
            try:
                req.audio, req.meta = self.engine.synth(req)
                req.state = STATE_DONE
            except AdapterError as exc:
                req.error = exc
                req.state = STATE_FAILED
            except Exception as exc:  # 引擎内部异常：原样呈现，不猜原因（D14）
                LOG.error("synthesis failed: %s", traceback.format_exc(limit=3))
                req.error = AdapterError(
                    "DP-TTS-500",
                    f"{type(exc).__name__}: {exc}",
                    "查看 IndexTTS 侧日志；本应用不替用户安装、修复或重启引擎",
                )
                req.state = STATE_FAILED
            finally:
                req.done.set()
                with self._lock:
                    self._current = None
