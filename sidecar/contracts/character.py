"""文件职责：角色包（需求 §6.1）的 Pydantic 契约——五个 JSON 文件的形状与取值边界。

依赖方向：contracts -> contracts（api_models 的 8 维情感向量长度）；不 import 任何业务模块。
谁调用：services/character_store.py 读盘与体检；将来 /persona/import 与角色包导出复用同一批模型。
约定：字段名即磁盘格式。改字段名等于改角色包格式（PLAN §8.1 的 P0 项），必须同步 §6.1 的字段表。
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator

from contracts.api_models import EMOTION_VECTOR_SIZE

#: 角色包格式版本。包声明了更高的版本 = 本程序太旧：直接报错，不做降级猜测（宁可让用户升级）。
SUPPORTED_PACK_VERSION = 1

#: voice.json 支持的语言，与 §6.12 适配器的 SUPPORTED_LANGS 保持一致。
SUPPORTED_TTS_LANGS: tuple[str, ...] = ("ZH", "EN", "JA", "AR", "ES")

#: 8 个基础情感标签（与 §3.3 的 8 维向量顺序一一对应）。缺哪个，角色就演不出那种情绪。
EMOTION_DIMENSION_TAGS: tuple[str, ...] = ("喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静")

#: 参考音建议时长（秒）。§6.1 要求 8–12 秒、单人、无 BGM；区间外只报警告，不拦住加载。
REF_AUDIO_MIN_S = 8.0
REF_AUDIO_MAX_S = 12.0

#: 未在 appearance.json 里指定立绘时去哪里找（相对角色包根目录）。
DEFAULT_PORTRAIT = "assets/portrait.png"
#: 未在 voice.json 里指定参考音时去哪里找。
DEFAULT_REF_AUDIO = "assets/reference.wav"

#: char_id 直接当目录名与记忆分区键，限制字符集免得出现路径穿越与大小写陷阱。
_CHAR_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: 0–1 的强度值（主动性、啰嗦度、反附和强度、关系初始值都用它）。
Unit = Annotated[float, Field(ge=0.0, le=1.0)]


class StrictModel(BaseModel):
    """角色包所有模型的共同基类：未知字段直接报错。

    理由：角色包是用户手写 / 手改的 JSON，打错一个键名如果被静默忽略，
    表现是「我明明写了却没生效」，比报错难查得多。
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CharacterCard(StrictModel):
    """card.json：人格正文 + 行为参数（字段表见需求 §6.1）。

    前五个是必填的人格正文；其余留空也能跑，只是角色会显得单薄。
    """

    name: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    personality: str = Field(min_length=1)
    speaking_style: str = Field(min_length=1)
    scenario: str = ""
    first_mes: str = ""
    alternate_greetings: list[str] = Field(default_factory=list)
    mes_example: list[str] = Field(default_factory=list)
    # --- 行为参数（v1.3 起进 card.json，不再是外部卡片格式）---
    proactive: Unit = 0.4
    verbosity: Unit = 0.5
    nsfw: bool = False
    language: str = "zh"
    tts_lang: str = "ZH"
    relationship_initial: Unit = 0.5
    anti_sycophancy: Unit = 0.7

    @field_validator("tts_lang")
    @classmethod
    def _check_tts_lang(cls, value: str) -> str:
        """TTS 语言必须是我们真的能合成的几种，否则角色会「开口就是错的音」。"""
        normalized = value.upper()
        if normalized not in SUPPORTED_TTS_LANGS:
            raise ValueError(
                "tts_lang 只支持 " + " / ".join(SUPPORTED_TTS_LANGS) + "，收到 " + value
            )
        return normalized

    @field_validator("language")
    @classmethod
    def _check_language(cls, value: str) -> str:
        """对话语言：只做形状检查（2–5 个字母），内容交给提示词装配。"""
        if not value.isalpha() or not 2 <= len(value) <= 5:
            raise ValueError("language 应是 2–5 个字母的语言码（如 zh / en），收到 " + value)
        return value.lower()


class VoiceConfig(StrictModel):
    """voice.json：音色引用。本项目只「调用」引擎，参考音由用户提供（D14）。"""

    engine: str = "indextts"
    ref_audio: str = ""
    ref_text: str = ""
    lang: str = "ZH"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch: float = Field(default=0.0, ge=-12.0, le=12.0)
    rvc_model: str | None = None

    @field_validator("lang")
    @classmethod
    def _check_lang(cls, value: str) -> str:
        """同 card.json 的 tts_lang：只认适配器支持的语言。"""
        normalized = value.upper()
        if normalized not in SUPPORTED_TTS_LANGS:
            raise ValueError("lang 只支持 " + " / ".join(SUPPORTED_TTS_LANGS) + "，收到 " + value)
        return normalized


class EmotionEntry(StrictModel):
    """emotion_map.json 的一项：8 维向量 + 两种形象后端各自的表达名（§6.6）。

    live2d_expr / png 允许留空：留空表示这个情绪只给 TTS 用，不切表情。
    """

    vector: list[float] = Field(min_length=EMOTION_VECTOR_SIZE, max_length=EMOTION_VECTOR_SIZE)
    live2d_expr: str | None = None
    png: str | None = None

    @field_validator("vector")
    @classmethod
    def _check_vector(cls, value: list[float]) -> list[float]:
        """每一维都是 0–1 的强度：IndexTTS 的情感向量不接受别的量纲。"""
        for index, item in enumerate(value):
            if not 0.0 <= item <= 1.0:
                raise ValueError(f"vector 第 {index} 维应在 0–1 之间，收到 {item}")
        return value


class EmotionMap(RootModel[dict[str, EmotionEntry]]):
    """emotion_map.json 的顶层就是「标签 -> 条目」映射（§6.1），没有额外包装层。

    标签由 LLM 直接输出（如「害羞」），所以用 dict 而不是固定枚举——
    新增一个情绪标签不该需要改代码。
    """

    @field_validator("root")
    @classmethod
    def _check_tags(cls, value: dict[str, EmotionEntry]) -> dict[str, EmotionEntry]:
        for tag in value:
            if not 1 <= len(tag) <= 24:
                raise ValueError("情绪标签长度应在 1–24 字符之间，收到 " + repr(tag))
        return value


class ActTarget(StrictModel):
    """appearance.json 里一个动作在两个后端上的落点。"""

    live2d: str | None = None
    png: str | None = None


class AppearanceConfig(StrictModel):
    """appearance.json：形象双轨（§6.6）。

    stage="png" 只看 portrait；stage="live2d" 缺模型时自动回退 PNG（png_fallback / portrait）；
    stage="hybrid" 表示 Live2D 待机 + 静态 CG 叠层，两者都要有。
    """

    stage: Literal["png", "live2d", "hybrid"] = "png"
    portrait: str | None = None
    model: str | None = None
    png_fallback: str | None = None
    motions: dict[str, str] = Field(default_factory=dict)
    expressions: dict[str, str] = Field(default_factory=dict)
    acts: dict[str, ActTarget] = Field(default_factory=dict)


class PackInfo(StrictModel):
    """pack.json：打包信息（导入 / 导出与版本兼容读它）。"""

    pack_version: int = Field(default=SUPPORTED_PACK_VERSION, ge=1)
    char_id: str
    display_name: str = ""
    author: str = ""
    license: str = ""

    @field_validator("char_id")
    @classmethod
    def _check_char_id(cls, value: str) -> str:
        if not _CHAR_ID_RE.fullmatch(value):
            raise ValueError(
                "char_id 只能是字母 / 数字 / 下划线 / 短横，且不超过 64 字符：" + value
            )
        return value

    @field_validator("pack_version")
    @classmethod
    def _check_pack_version(cls, value: int) -> int:
        if value > SUPPORTED_PACK_VERSION:
            raise ValueError(
                f"角色包格式版本 {value} 高于本程序支持的 {SUPPORTED_PACK_VERSION}，请升级 deskpet"
            )
        return value


__all__ = [
    "DEFAULT_PORTRAIT",
    "DEFAULT_REF_AUDIO",
    "EMOTION_DIMENSION_TAGS",
    "REF_AUDIO_MAX_S",
    "REF_AUDIO_MIN_S",
    "SUPPORTED_PACK_VERSION",
    "SUPPORTED_TTS_LANGS",
    "ActTarget",
    "AppearanceConfig",
    "CharacterCard",
    "EmotionEntry",
    "EmotionMap",
    "PackInfo",
    "VoiceConfig",
]
