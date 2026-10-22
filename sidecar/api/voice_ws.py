"""文件职责：WebSocket /ws/voice —— 语音全双工的唯一长连接（P2）。

依赖方向：api -> services（注入的 VoiceSession 工厂）/ contracts；不 import adapters。
谁调用：api/router.py 挂载；主进程的 app/main/voice-socket.ts 是唯一客户端。

帧约定（详见 contracts/voice_ws.py）：
- 客户端 → 服务端：二进制 = PCM16；文本 = audio.start / audio.end / cancel / text；
- 服务端 → 客户端：文本 = 事件；`tts.audio` 事件后紧跟一个二进制音频帧。
鉴权：主进程把 token 放在查询串（WS 在浏览器侧不能自定义头）；只监听回环，且 token 每进程随机。
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from contracts.voice_ws import (
    VOICE_CONTROL_ADAPTER,
    AudioEnd,
    AudioStart,
    TextInput,
    VoiceCancel,
)
from core.logging import get_logger, log_event
from services.voice_session import VoiceSession

LOGGER = get_logger("sidecar.api.voice_ws")

#: 音频缓冲上限：30 秒 @16k/16bit（超过就丢掉最旧的部分，防止一条连接把内存吃满）。
MAX_AUDIO_BYTES = 16000 * 2 * 30

VoiceSessionFactory = Callable[[], VoiceSession]


def build_voice_ws_router(session_factory: VoiceSessionFactory) -> APIRouter:
    """挂载 /ws/voice；每条连接一个独立的 VoiceSession（generation / 缓冲互不干扰）。"""
    router = APIRouter()

    @router.websocket("/ws/voice")
    async def voice_ws(websocket: WebSocket) -> None:
        expected = getattr(websocket.app.state, "sidecar_token", None)
        if expected is not None and websocket.query_params.get("token") != expected:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        session = session_factory()
        buffer = bytearray()
        task: asyncio.Task[None] | None = None

        async def pump(pcm: bytes, asr_text: str | None) -> None:
            """把一轮流水线的输出原样写回连接；被打断 / 断连就安静退出。"""
            try:
                async for out in session.run(pcm, asr_text=asr_text):
                    if out.event is not None:
                        await websocket.send_text(json.dumps(out.event, ensure_ascii=False))
                    if out.audio is not None:
                        await websocket.send_bytes(out.audio)
            except asyncio.CancelledError:
                raise
            except (WebSocketDisconnect, RuntimeError):
                return
            except Exception as exc:  # 兜底：不让后台任务把异常静默吞掉
                log_event(
                    LOGGER,
                    logging.ERROR,
                    module="api.voice_ws",
                    event="voice.pump_failed",
                    message="语音流水线写回失败",
                    fields={"reason": type(exc).__name__, "error": str(exc)},
                )

        def replace_task(pcm: bytes, asr_text: str | None) -> None:
            nonlocal task
            if task is not None:
                task.cancel()
            task = asyncio.create_task(pump(pcm, asr_text))

        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    chunk = message["bytes"]
                    buffer.extend(chunk)
                    if len(buffer) > MAX_AUDIO_BYTES:
                        del buffer[: len(buffer) - MAX_AUDIO_BYTES]
                    # 流式识别（P2）：边收边喂，partial 有变化就推给客户端
                    partial = await session.accept_audio(chunk)
                    if partial:
                        await websocket.send_text(
                            json.dumps({"t": "asr.partial", "text": partial}, ensure_ascii=False)
                        )
                    continue
                raw = message.get("text") or ""
                try:
                    control = VOICE_CONTROL_ADAPTER.validate_json(raw)
                except ValidationError:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "t": "error",
                                "code": "DP-SYS-400",
                                "user_hint": "语音控制消息格式不对",
                            },
                            ensure_ascii=False,
                        )
                    )
                    continue

                if isinstance(control, AudioStart):
                    # 新一轮开口：先把上一轮还在跑的流水线停掉，再换识别流
                    if task is not None:
                        task.cancel()
                        task = None
                    buffer.clear()
                    await session.begin(
                        session_id=control.session_id,
                        char_id=control.char_id,
                        sample_rate=control.sample_rate,
                        tts_enabled=control.tts_enabled,
                    )
                elif isinstance(control, AudioEnd):
                    # session_id / char_id 以 audio.start 为准；end 里重复给出也只是冗余信息
                    pcm = bytes(buffer)
                    buffer.clear()
                    replace_task(pcm, None)
                elif isinstance(control, VoiceCancel):
                    session.cancel()
                    if task is not None:
                        task.cancel()
                        task = None
                    await websocket.send_text(
                        json.dumps({"t": "state", "state": "idle"}, ensure_ascii=False)
                    )
                elif isinstance(control, TextInput):
                    if task is not None:
                        task.cancel()
                        task = None
                    await session.begin(
                        session_id=control.session_id,
                        char_id=control.char_id,
                        sample_rate=16000,
                        start_asr=False,
                        tts_enabled=control.tts_enabled,
                    )
                    replace_task(b"", control.text)
        except WebSocketDisconnect:
            pass
        finally:
            if task is not None:
                task.cancel()

    return router


__all__ = ["MAX_AUDIO_BYTES", "build_voice_ws_router"]
