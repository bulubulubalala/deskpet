"""文件职责：语音全双工 WebSocket 的控制消息契约（P2 / 需求 §6.3 的语音补章）。

依赖方向：只依赖 pydantic；被 api/voice_ws.py 解析、services/voice_session.py 产出事件。
约定：
- **二进制帧** = 16-bit 小端单声道 PCM（采样率由 audio.start 指定，默认 16k），不包 JSON；
- **文本帧** = 控制消息 / 服务端事件（一行 JSON）。
- 服务端的 `tts.audio` 事件后面**紧跟一个二进制帧**（该句音频），两者按顺序配对。
- 所有事件都带 `t`；未知 `t` 一律忽略（向前兼容）。

为什么单独一份契约：现有 /asr、/chat/stream、/tts 是「一次请求一次响应」，而全双工需要
一条长连接里同时跑「音频上行 / partial 下行 / 合成音频下行 / 取消」；把消息形状钉在这里，
主进程与 sidecar 才能各自演进而不漂移。
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class _Control(BaseModel):
    """客户端控制消息的公共配置：未知字段直接报错（防止悄悄改协议）。"""

    model_config = ConfigDict(extra="forbid")


class AudioStart(_Control):
    """开始一轮收音：清空音频缓冲、记会话上下文，并作废上一轮在途结果。"""

    t: Literal["audio.start"] = "audio.start"
    session_id: str = Field(min_length=1)
    char_id: str = Field(min_length=1)
    sample_rate: int = Field(default=16000, ge=8000, le=48000)
    #: 语音输出开关（聊天条麦克风旁）：false = 只出文字事件，不做 TTS 合成。
    tts_enabled: bool = True


class AudioEnd(_Control):
    """这一句说完了：sidecar 对已缓冲的 PCM 做识别，然后走 LLM/TTS。"""

    t: Literal["audio.end"] = "audio.end"
    session_id: str = ""
    char_id: str = ""


class VoiceCancel(_Control):
    """打断：抬 generation、停掉在途的识别 / 生成 / 合成。"""

    t: Literal["cancel"] = "cancel"


class TextInput(_Control):
    """通过同一条通道发文字（调试 / 键盘输入也能走这套编排）。"""

    t: Literal["text"] = "text"
    session_id: str = Field(min_length=1)
    char_id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    tts_enabled: bool = True


VoiceControl = Annotated[AudioStart | AudioEnd | VoiceCancel | TextInput, Field(discriminator="t")]
VOICE_CONTROL_ADAPTER: TypeAdapter[VoiceControl] = TypeAdapter(VoiceControl)

#: 服务端事件种类（与 app/main/ipc.ts 的 VOICE_EVENT_KINDS 对齐，契约测试会对账）。
VOICE_EVENT_KINDS: tuple[str, ...] = (
    "state",
    "asr.partial",
    "asr.final",
    "asr.empty",
    "llm.s",
    "llm.m",
    "llm.a",
    "llm.end",
    "tts.audio",
    "error",
)

#: 服务端语音状态（与 VoiceStateName 同源，单独列一份让 WS 事件不必 import health）。
VOICE_STATES: tuple[str, ...] = ("idle", "listening", "thinking", "speaking", "cancelling")

__all__ = [
    "VOICE_CONTROL_ADAPTER",
    "VOICE_EVENT_KINDS",
    "VOICE_STATES",
    "AudioEnd",
    "AudioStart",
    "TextInput",
    "VoiceCancel",
    "VoiceControl",
]
