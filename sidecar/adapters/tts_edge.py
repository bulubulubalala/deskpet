"""文件职责：edge-tts 在线合成的适配器——TTS provider = edge 的唯一出口（T2.4）。

依赖方向：adapters -> contracts / core；不 import services / api。
谁调用：services/tts_service.py 的 build_tts_service 按 provider 注入；单测 mock 掉 edge_tts。

边界（对齐 D14 的精神，但这里是完全在进程内的库调用）：
edge-tts 是**逆向微软 Edge 在线朗读服务**的第三方库（ToS 灰色、需联网、不能克隆角色音色）。
本项目只把它当作「一个可选的云端 provider」：默认仍是 local 的 IndexTTS；用户在 .env 里
把 DESKPET_TTS_PROVIDER 改成 edge 才会走这条。引擎/服务变动由库与用户自行承担。

取消语义：edge-tts 每次合成都是一次独立的 websocket 往返，没有可取消的队列；「打断」的
<200ms 停播由播放侧（T1.6）保证，这里只能如实回 unknown（这句要么已经合成完、要么不存在）。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from contracts.api_models import TtsRequest
from contracts.errors import CODE_TTS_ADAPTER_ERROR, CODE_TTS_NOT_AVAILABLE
from core.errors import TtsError
from core.logging import get_logger
from core.tts import CANCEL_UNKNOWN, TtsAudio

LOGGER = get_logger("sidecar.adapters.tts_edge")

#: edge-tts 的输出格式是 audio-24khz-48kbitrate-mono-mp3：48 kbit/s = 6000 字节/秒 = 6 字节/毫秒。
#: 用它从字节数反推音频时长（拿不到解码后的真实时长，只能这样估）。
MP3_BYTES_PER_MS = 6.0

#: edge 的音色名形如 zh-CN-XiaoxiaoNeural / en-US-AriaNeural；用它区分「角色包给了个 edge 音色」
#: 还是本地 IndexTTS 的参考音路径（后者不能喂给 edge）。
_EDGE_VOICE_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$")

USER_HINT_EDGE_MISSING = "edge 在线合成不可用：请确认已安装 edge-tts 且网络可达，或把来源改回本地。"
USER_HINT_EDGE_ERROR = "edge 在线合成出错了，这句话先跳过；原因见日志。"


@dataclass(frozen=True, slots=True)
class EdgeTtsEndpoint:
    """edge-tts 的音色与调节（rate / pitch 是 edge 的字符串旋钮，如 "+10%" / "-2Hz"）。"""

    voice: str
    rate: str = ""
    pitch: str = ""


class EdgeTtsClient:
    """按 edge-tts 合成一句；失败一律抛 TtsError（错误码域仍归 TTS，§6.4）。"""

    def __init__(self, endpoint: EdgeTtsEndpoint) -> None:
        self._endpoint = endpoint

    async def synthesize(self, request: TtsRequest) -> TtsAudio:
        """合成一句 → MP3 字节 + 估算的性能数字。"""
        edge_tts = _import_edge_tts()
        voice = self._voice_for(request.voice_id)
        options: dict[str, str] = {}
        if self._endpoint.rate:
            options["rate"] = self._endpoint.rate
        if self._endpoint.pitch:
            options["pitch"] = self._endpoint.pitch
        started = time.perf_counter()
        chunks: list[bytes] = []
        try:
            communicate = edge_tts.Communicate(request.text, voice, **options)
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    data = chunk.get("data")
                    if isinstance(data, bytes) and data:
                        chunks.append(data)
        except Exception as exc:
            raise TtsError(
                CODE_TTS_ADAPTER_ERROR,
                "edge-tts 合成失败（" + type(exc).__name__ + "：" + str(exc) + "）",
                user_hint=USER_HINT_EDGE_ERROR,
                context={"voice": voice},
            ) from exc
        audio = b"".join(chunks)
        if not audio:
            raise TtsError(
                CODE_TTS_ADAPTER_ERROR,
                "edge-tts 没有返回音频数据",
                user_hint=USER_HINT_EDGE_ERROR,
                context={"voice": voice},
            )
        gen_ms = max(0, round((time.perf_counter() - started) * 1000))
        audio_ms = round(len(audio) / MP3_BYTES_PER_MS)
        rtf = gen_ms / audio_ms if audio_ms > 0 else 0.0
        LOGGER.debug("tts.edge_synth", "edge-tts 合成完成", extra={"dp": {"voice": voice}})
        return TtsAudio(
            audio=audio,
            request_id=request.request_id,
            gen_ms=gen_ms,
            audio_ms=audio_ms,
            rtf=rtf,
            voice=voice,
            format="mp3",
        )

    async def cancel(self, request_id: str) -> str:
        """edge-tts 没有可取消的队列：如实回 unknown（真正的打断在播放侧）。"""
        return CANCEL_UNKNOWN

    def _voice_for(self, requested: str) -> str:
        """角色包给了合法的 edge 音色名就用它，否则用配置的默认音色。

        为什么判别：/tts 的 voice_id 在本地 provider 下是**参考音绝对路径**，直接喂给 edge
        会被拒；只有形如 zh-CN-XiaoxiaoNeural 的值才当音色名用。
        """
        candidate = requested.strip()
        if _EDGE_VOICE_RE.fullmatch(candidate):
            return candidate
        return self._endpoint.voice


def _import_edge_tts() -> Any:
    """延迟导入 edge_tts：没装时给明确的 DP-TTS-503，而不是 ImportError 崩掉进程。

    返回 Any：edge_tts 没有 py.typed，调用处只用到 Communicate / stream（适配器层 mypy 放宽，
    见 pyproject 的 module override）。
    """
    try:
        import edge_tts
    except ImportError as exc:
        raise TtsError(
            CODE_TTS_NOT_AVAILABLE,
            "edge-tts 未安装（" + str(exc) + "）",
            user_hint=USER_HINT_EDGE_MISSING,
        ) from exc
    return edge_tts
