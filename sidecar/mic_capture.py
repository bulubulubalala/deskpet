"""文件职责：Windows 原生麦克风采集（Chromium getUserMedia 不可用时的兜底）。

为什么需要它：部分 Windows 音频驱动会让 Chromium 的 WASAPI 输入初始化失败
（`IAudioClient::Initialize` 0x80070057），而其他原生应用（微信 / 录音机）仍能录音。
这里用 PortAudio 的 WDM-KS / WASAPI 回调直接采集，把 48 kHz / 16-bit / 单声道 PCM
写到 stdout，由主进程转发给渲染层复用现有 VAD 与语音流水线。

协议：stdout 只写裸 PCM16LE；日志与错误一律写 stderr。由 `sidecar/main.py --mic-capture`
启动；进程退出即停止采集。没有 AEC（原生兜底不提供 Chromium 的回声消除）。
"""

from __future__ import annotations

import contextlib
import os
import queue
import sys
import threading
from typing import Any

try:
    import sounddevice as sd
except Exception as error:  # pragma: no cover - 只在缺依赖的机器上走这里
    sys.stderr.write(f"native mic dependency missing: {type(error).__name__}: {error}\n")
    raise SystemExit(2) from None

SAMPLE_RATE = 48_000
CHANNELS = 1
DTYPE = "int16"
QUEUE_CHUNKS = 32


def _device_candidates() -> list[int]:
    """优先 WDM-KS（这台机器的 THS318 只有 WDM-KS 回调可用），再试其他 host API。"""
    override = os.environ.get("DESKPET_MIC_DEVICE", "").strip()
    if override:
        with contextlib.suppress(ValueError):
            return [int(override)]
    hostapis = sd.query_hostapis()
    priorities = ["WDM-KS", "Windows WASAPI", "MME", "Windows DirectSound"]
    candidates: list[int] = []
    for name in priorities:
        for host in hostapis:
            if name not in str(host.get("name", "")):
                continue
            default_input = int(host.get("default_input_device", -1))
            if default_input >= 0:
                candidates.append(default_input)
            for device_index in host.get("devices", []):
                try:
                    info = sd.query_devices(int(device_index))
                except Exception:
                    continue
                if int(info.get("max_input_channels", 0)) > 0:
                    candidates.append(int(device_index))
    # 去重但保持优先级
    seen: set[int] = set()
    unique: list[int] = []
    for index in candidates:
        if index not in seen:
            seen.add(index)
            unique.append(index)
    return unique


def _open_stream(chunks: queue.Queue[bytes]) -> tuple[sd.RawInputStream, int]:
    errors: list[str] = []
    for device in _device_candidates():
        try:
            info = sd.query_devices(device)
            if int(info.get("max_input_channels", 0)) < 1:
                continue
            speech_seen = threading.Event()

            def callback(
                indata: Any,
                frames: int,
                _time_info: Any,
                status: Any,
                ready: threading.Event = speech_seen,
            ) -> None:
                if status:
                    sys.stderr.write(f"native mic status: {status}\n")
                if frames > 0:
                    ready.set()
                try:
                    chunks.put_nowait(bytes(indata))
                except queue.Full:
                    # 让采集线程永不阻塞；丢最旧的一块（延迟优先）
                    with contextlib.suppress(queue.Empty):
                        chunks.get_nowait()
                    with contextlib.suppress(queue.Full):
                        chunks.put_nowait(bytes(indata))

            stream = sd.RawInputStream(
                device=device,
                channels=CHANNELS,
                samplerate=SAMPLE_RATE,
                dtype=DTYPE,
                blocksize=0,
                callback=callback,
            )
            stream.start()
            if speech_seen.wait(timeout=1.5):
                sys.stderr.write(
                    f"native mic: device={device} name={info.get('name', '')} "
                    f"host={info.get('hostapi', '')}\n"
                )
                return stream, device
            stream.stop()
            stream.close()
            errors.append(f"device {device}: no data")
        except Exception as error:
            errors.append(f"device {device}: {type(error).__name__}: {error}")
    raise RuntimeError("; ".join(errors) or "没有可用的输入设备")


def run_mic_capture() -> int:
    """持续写 PCM 到 stdout，直到父进程关闭管道 / 终止进程。"""
    chunks: queue.Queue[bytes] = queue.Queue(maxsize=QUEUE_CHUNKS)
    stream: sd.RawInputStream | None = None
    try:
        stream, _device = _open_stream(chunks)
        out = sys.stdout.buffer
        while True:
            try:
                chunk = chunks.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                out.write(chunk)
                out.flush()
            except (BrokenPipeError, OSError):
                return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        sys.stderr.write(f"native mic failed: {type(error).__name__}: {error}\n")
        return 2
    finally:
        if stream is not None:
            with contextlib.suppress(Exception):
                stream.stop()
            with contextlib.suppress(Exception):
                stream.close()


if __name__ == "__main__":
    raise SystemExit(run_mic_capture())
