"""文件职责：LLM 逐行 JSON 事件的契约（需求 §6.2）。

依赖方向：只依赖 pydantic。
谁调用：core 的事件解析器（M1）、契约测试；LLM 的输出格式由本模块钉死。
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from contracts.errors import ERROR_CODE_PATTERN

# IndexTTS 硬上限：单句超过这个字数会吞字（需求 §3.5 / §6.2）
MAX_SENTENCE_CHARS = 40

#: 事件判别值全集（跨语言锚点：app/main/ipc.ts 的 CHAT_EVENT_KINDS 必须与它一致）。
#: 放在这里而不是 routes.py，是为了让「事件种类」只有一个定义处：契约测试拿它对账
#: OpenAPI 的 t 枚举、ipc.ts 的常量表与实际解析器接受的类型。
LLM_EVENT_KINDS: tuple[str, ...] = ("s", "m", "a", "end", "e")


class _EventBase(BaseModel):
    """所有事件的公共配置：出现未知字段就报错（防止悄悄改协议）。"""

    model_config = ConfigDict(extra="forbid")


class SentenceEvent(_EventBase):
    """一句话：逐句播报，并驱动表情与动作。"""

    t: Literal["s"] = "s"
    i: int = Field(default=0, ge=0, description="句子序号，从 0 开始")
    text: str = Field(min_length=1, max_length=MAX_SENTENCE_CHARS)
    emotion: str | None = Field(default=None, description="必须是角色包 emotion_map 里的键")
    intensity: float = Field(default=0.5, ge=0, le=1)
    act: str | None = None


class MemoryEvent(_EventBase):
    """要写进记忆的事实；去重与重要度计算在 M2 落地。"""

    t: Literal["m"] = "m"
    kind: Literal["fact", "preference", "event"]
    text: str = Field(min_length=1)
    importance: float = Field(default=0.5, ge=0, le=1)


class ActEvent(_EventBase):
    """只驱动形象、不说话的动作。"""

    t: Literal["a"] = "a"
    act: str = Field(min_length=1)
    why: str | None = None


class EndEvent(_EventBase):
    """本轮回复结束（SSE 流到此为止）。"""

    t: Literal["end"] = "end"


class ErrorEvent(_EventBase):
    """技术故障的用户提示（§6.7 的 A 级降级需要它）。

    为什么不能复用 SentenceEvent：§7.4 / §6.8 要求角色台词与技术提示是两条通道——
    台词归角色演，故障归系统说。把「网络不通」塞进 s 会让角色替系统背锅，也让
    限频与去重规则（F9）无从下手。
    """

    t: Literal["e"] = "e"
    code: str = Field(pattern=ERROR_CODE_PATTERN, description="§6.4 错误码，例如 DP-LLM-003")
    user_hint: str = Field(min_length=1, description="给用户看的技术提示（不含排查命令）")
    recoverable: bool = Field(default=True, description="false 表示重试也救不回来")


LlmEvent = Annotated[
    SentenceEvent | MemoryEvent | ActEvent | EndEvent | ErrorEvent, Field(discriminator="t")
]
LLM_EVENT_ADAPTER: TypeAdapter[LlmEvent] = TypeAdapter(LlmEvent)
