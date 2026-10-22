"""文件职责：sidecar 运行时配置（CODE_STYLE §1.6：可调参数集中于此）。

依赖方向：只依赖标准库与 core.memory（纯数据模块，用来复用记忆预算的默认值），
不 import services / adapters / api。
谁调用：sidecar/main.py 启动时读一次；测试用 load_settings(env={...}) 注入。
约定：这里的默认值必须与仓库根 .env.example 保持一致。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from core.memory import (
    DECAY_HALF_LIFE_DAYS,
    DEFAULT_EPISODE_LIMIT,
    DEFAULT_HISTORY_BUDGET_TOKENS,
    DEFAULT_IMPRESSION_MESSAGES,
    DEFAULT_L1_AGGREGATE_SUMMARIES,
    DEFAULT_L1_BUDGET_TOKENS,
    DEFAULT_L2_AGGREGATE_SUMMARIES,
    DEFAULT_L2_BUDGET_TOKENS,
    DEFAULT_L3_BUDGET_TOKENS,
    DEFAULT_OBSERVATION_BUDGET_TOKENS,
    DEFAULT_PERMANENT_IMPORTANCE,
    DEFAULT_RECALL_BUDGET_TOKENS,
    DEFAULT_RECALL_LIMIT,
    DEFAULT_RECENT_TURNS,
    DEFAULT_RETENTION_DAYS,
    DEFAULT_SUMMARY_BATCH_MESSAGES,
    DEFAULT_SUMMARY_TRIGGER_MESSAGES,
    DEFAULT_SUMMARY_TRIGGER_TOKENS,
)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8737
DEFAULT_LOG_LEVEL = "info"
RUNTIME_FILE_NAME = "runtime.json"
CHARACTERS_DIR_NAME = "characters"
LOG_DIR_NAME = "logs"
LOG_FILE_NAME = "deskpet.log"
#: 需求 §6.7：日志滚动保留 7 天 / 20MB
DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_LOG_RETENTION_DAYS = 7
#: 需求 §6.7：首 token 20s、整体 60s、退避重试 1s / 3s（最多两次）
DEFAULT_LLM_FIRST_TOKEN_TIMEOUT_S = 20.0
DEFAULT_LLM_TOTAL_TIMEOUT_S = 60.0
DEFAULT_LLM_RETRY_DELAYS_S: tuple[float, ...] = (1.0, 3.0)
#: 需求 §2 D4 / §6.7：本地 ASR = small + int8 + CPU，单次识别超时 15s
DEFAULT_ASR_MODEL = "small"
DEFAULT_ASR_DEVICE = "cpu"
DEFAULT_ASR_COMPUTE_TYPE = "int8"
DEFAULT_ASR_BEAM_SIZE = 1
DEFAULT_ASR_TIMEOUT_S = 15.0
#: provider = cloud 时的默认转录模型：Groq 的 whisper-large-v3-turbo（OpenAI 兼容口）。
DEFAULT_ASR_CLOUD_MODEL = "whisper-large-v3-turbo"
#: 流式识别（P2）：sherpa-onnx 中文流式 zipformer 的默认相对目录（模型不进安装包）。
ASR_STREAM_MODEL_DIR_NAME = "models/asr-stream/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
DEFAULT_ASR_STREAM_THREADS = 2
#: 需求 §6.12 / D14：常驻 TTS 适配器由用户自己部署，本项目只调用它
DEFAULT_TTS_URL = "http://127.0.0.1:8742"
#: 需求 §6.7：单句合成预算 30s（超时只跳过这一句，不打断整轮对话）
DEFAULT_TTS_TIMEOUT_S = 30.0
#: 识图：OpenAI 兼容视觉端点（本地 Ollama / llama.cpp / 云端均可）
DEFAULT_VISION_BASE_URL = "http://127.0.0.1:11434/v1"
DEFAULT_VISION_MODEL = ""
DEFAULT_VISION_TIMEOUT_S = 45.0
DEFAULT_VISION_MAX_IMAGE_BYTES = 8_000_000
#: 使用统计库文件名（需求 §6.9；与 memories.db 分离，清空互不影响）
USAGE_DB_NAME = "usage.db"
#: 模型缓存目录名（相对数据目录）；模型不进安装包，首次使用时下载到这里
ASR_MODEL_DIR_NAME = "models/asr"
#: 记忆库文件名（需求 §6.4；与 usage.db 分开，清空记忆不影响使用统计）
MEMORY_DB_NAME = "memories.db"
#: 记忆库密钥文件名（需求 §6.5；DPAPI 保护的 32 字节，丢了就读不回记忆）
MEMORY_KEY_NAME = "key.blob"
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def default_data_dir(*, frozen: bool | None = None, executable: str | None = None) -> Path:
    """返回数据目录默认值（参数可注入，便于单测，T0.8）。

    源码态：仓库 data/（与 .env.example 一致）。
    打包态（PyInstaller onedir）：__file__ 落在 bundle 内，往它旁边写等于往只读资源里写，
    故改用「exe 所在目录 / data」；实际运行时 Electron 一定会传 DESKPET_DATA_DIR
    （打包态落 userData/data），这里的默认值只服务于「单独跑 sidecar.exe 自检」这种场景。
    """
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        exe = sys.executable if executable is None else executable
        return Path(exe).parent / "data"
    return SOURCE_ROOT / "data"


DEFAULT_DATA_DIR = default_data_dir()


def default_characters_dir(*, frozen: bool | None = None, executable: str | None = None) -> Path:
    """返回角色包目录默认值（F6 / §6.1）。

    源码态：仓库根 characters/（与 §9.1 的目录结构一致）。
    打包态：exe 旁边的 characters/；实际运行时 Electron 一定会传 DESKPET_CHARACTERS_DIR
    （打包态落 userData/characters，因为安装目录通常不可写，角色包又必须可写）。
    """
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        exe = sys.executable if executable is None else executable
        return Path(exe).parent / CHARACTERS_DIR_NAME
    # SOURCE_ROOT 就是仓库根（sidecar/config.py 的上一层），角色包目录 = 仓库根/characters；
    # 早期写成 SOURCE_ROOT.parent 会把默认值指到仓库外面（D:\Agent_Projects\characters），
    # 结果是「不设 DESKPET_CHARACTERS_DIR 就找不到任何角色」——端到端冒烟才暴露出来。
    return SOURCE_ROOT / CHARACTERS_DIR_NAME


DEFAULT_CHARACTERS_DIR = default_characters_dir()
DEFAULT_ASR_MODEL_DIR = DEFAULT_DATA_DIR / ASR_MODEL_DIR_NAME

#: 模型供给层（需求 §6.13 / 决策 D19）：每个能力面选 cloud 或 local。
#: 默认保持现状——LLM 云端、ASR / TTS 本地；本地 LLM 只要填 local_base_url / local_model 就能用。
PROVIDER_CLOUD = "cloud"
PROVIDER_LOCAL = "local"
#: edge-tts（微软 Edge 在线朗读）：零 key 的云端合成可选实现（T2.4，仅 TTS 面）。
PROVIDER_EDGE = "edge"
PROVIDERS: tuple[str, ...] = (PROVIDER_CLOUD, PROVIDER_LOCAL)
#: 各能力面允许的 provider：LLM 保持双轨；ASR 云端已实现（T2.4）；TTS 多一个 edge。
LLM_PROVIDERS: tuple[str, ...] = PROVIDERS
ASR_PROVIDERS: tuple[str, ...] = (PROVIDER_LOCAL, PROVIDER_CLOUD)
TTS_PROVIDERS: tuple[str, ...] = (PROVIDER_LOCAL, PROVIDER_CLOUD, PROVIDER_EDGE)
#: edge-tts 默认音色（zh-CN 女声）；角色包可用 voice.json 的 voice_id 覆盖。
DEFAULT_TTS_EDGE_VOICE = "zh-CN-XiaoxiaoNeural"


@dataclass(frozen=True, slots=True)
class LlmSettings:
    """LLM 接入配置（需求 §6.13 / 决策 D2、D19：云端与本地都只是「一个 OpenAI 兼容端点」）。

    主端点为空表示「还没配」——服务层据此给出明确提示，而不是默默不发请求。
    备用端点是 §6.7 的第二层降级；它的模型名留空时沿用主端点的模型名。
    provider 决定优先用哪一套：cloud 用 base_url / api_key / model；local 用
    local_base_url / local_api_key / local_model（Ollama、LM Studio、llama.cpp 等本地服务）。
    """

    base_url: str = ""
    api_key: str = ""
    model: str = ""
    fallback_base_url: str = ""
    fallback_model: str = ""
    first_token_timeout_s: float = DEFAULT_LLM_FIRST_TOKEN_TIMEOUT_S
    total_timeout_s: float = DEFAULT_LLM_TOTAL_TIMEOUT_S
    retry_delays_s: tuple[float, ...] = DEFAULT_LLM_RETRY_DELAYS_S
    provider: str = PROVIDER_CLOUD
    local_base_url: str = ""
    local_api_key: str = ""
    local_model: str = ""

    def endpoint_specs(self) -> tuple[tuple[str, str, str, str], ...]:
        """按 provider 给出有序端点表，每项是 (base_url, api_key, model, provider_label)。

        顺序：选中的 provider → 显式配置的 fallback_base_url → 另一个已配好的 provider。
        服务层按这个顺序逐端点重试（§6.7 第二层降级）；provider_label 会写进使用统计，
        所以「这一轮到底走的是云端还是本地」事后查得到（§6.9）。
        缺 base_url 或 model 的端点直接跳过；按 URL 去重，保证同一个端点只试一次。
        """
        cloud = (self.base_url.strip(), self.api_key.strip(), self.model.strip())
        local = (self.local_base_url.strip(), self.local_api_key.strip(), self.local_model.strip())
        cloud_first = self.provider == PROVIDER_CLOUD
        ordered = [cloud, local] if cloud_first else [local, cloud]
        labels = (
            [PROVIDER_CLOUD, PROVIDER_LOCAL] if cloud_first else [PROVIDER_LOCAL, PROVIDER_CLOUD]
        )
        candidates: list[tuple[str, str, str, str]] = []
        for (url, api_key, model), label in zip(ordered, labels, strict=True):
            if url and model:
                candidates.append((url, api_key, model, label))
        fallback_url = self.fallback_base_url.strip()
        if fallback_url:
            fallback_model = self.fallback_model.strip() or (candidates[0][2] if candidates else "")
            if fallback_model:
                # 显式备用端点沿用所选 provider 的密钥（同一家服务的另一个部署）
                fallback_spec = (fallback_url, ordered[0][1], fallback_model, "fallback")
                candidates.insert(1 if candidates else 0, fallback_spec)
        seen: set[str] = set()
        specs: list[tuple[str, str, str, str]] = []
        for spec in candidates:
            if spec[0] in seen:
                continue
            seen.add(spec[0])
            specs.append(spec)
        return tuple(specs)


@dataclass(frozen=True, slots=True)
class AsrSettings:
    """本地语音识别的配置（§2 D4：CPU + int8，不与 TTS 抢显存）。

    模型**不进安装包**：model 是 faster-whisper 的模型名或本地目录，model_dir 是下载缓存目录；
    首次识别时若缓存里没有模型，faster-whisper 会自己下载（失败 → DP-ASR-004 + 排查指引）。
    hf_endpoint 非空时写进 HF_ENDPOINT，给「下不动模型」留一个不用改代码的出口。
    """

    model: str = DEFAULT_ASR_MODEL
    device: str = DEFAULT_ASR_DEVICE
    compute_type: str = DEFAULT_ASR_COMPUTE_TYPE
    model_dir: Path = DEFAULT_ASR_MODEL_DIR
    language: str = ""
    beam_size: int = DEFAULT_ASR_BEAM_SIZE
    timeout_s: float = DEFAULT_ASR_TIMEOUT_S
    vad_filter: bool = True
    hf_endpoint: str = ""
    provider: str = PROVIDER_LOCAL
    #: provider = cloud 时用的 OpenAI 兼容转录端点（T2.4）：Groq / OpenAI / Azure 通用。
    cloud_base_url: str = ""
    cloud_api_key: str = ""
    cloud_model: str = DEFAULT_ASR_CLOUD_MODEL
    #: 流式识别（P2）：用 sherpa-onnx 的本地流式模型出 partial；模型缺失时自动退回批处理。
    streaming_enabled: bool = True
    stream_model_dir: Path = DEFAULT_DATA_DIR / ASR_STREAM_MODEL_DIR_NAME
    stream_threads: int = DEFAULT_ASR_STREAM_THREADS


@dataclass(frozen=True, slots=True)
class TtsSettings:
    """常驻 TTS 适配器的接入配置（需求 §6.12 / 决策 D14）。

    base_url 指**用户自己部署**的适配器进程（默认 127.0.0.1:8742），不是 IndexTTS 本体；
    token 是适配器的共享口令（可空）；timeout_s 是单句预算（§6.7 的 30s）。
    适配器侧还有自己的排队超时（默认 120s），两段时间是各管一段的。

    provider = edge 时走 edge-tts 在线合成（T2.4）：不需要 base_url，只看 edge_voice / rate
    与 pitch 三个旋钮。
    """

    base_url: str = DEFAULT_TTS_URL
    token: str = ""
    timeout_s: float = DEFAULT_TTS_TIMEOUT_S
    provider: str = PROVIDER_LOCAL
    #: edge-tts 音色名（如 zh-CN-XiaoxiaoNeural）；rate / pitch 是 edge 的调节串（"+0%" / "+0Hz"）。
    edge_voice: str = DEFAULT_TTS_EDGE_VOICE
    edge_rate: str = ""
    edge_pitch: str = ""


@dataclass(frozen=True, slots=True)
class VisionSettings:
    """屏幕识图：走 OpenAI 兼容视觉端点，不直接把画面落盘。"""

    base_url: str = DEFAULT_VISION_BASE_URL
    model: str = DEFAULT_VISION_MODEL
    api_key: str = ""
    timeout_s: float = DEFAULT_VISION_TIMEOUT_S
    max_image_bytes: int = DEFAULT_VISION_MAX_IMAGE_BYTES

    @property
    def configured(self) -> bool:
        return bool(self.base_url.strip() and self.model.strip())


@dataclass(frozen=True, slots=True)
class MemorySettings:
    """持久化记忆的配置（需求 §6.4 / F3）。

    预算单位是「估算 token」（CJK 每字 1、其余按 4 字符 1，见 core.memory.estimate_tokens）。
    0 表示这一层不注入；默认值来自 core.memory 的算法常量，环境变量可以逐项覆盖。
    """

    history_turns: int = DEFAULT_RECENT_TURNS
    recall_limit: int = DEFAULT_RECALL_LIMIT
    l3_budget_tokens: int = DEFAULT_L3_BUDGET_TOKENS
    l2_budget_tokens: int = DEFAULT_L2_BUDGET_TOKENS
    l1_budget_tokens: int = DEFAULT_L1_BUDGET_TOKENS
    recall_budget_tokens: int = DEFAULT_RECALL_BUDGET_TOKENS
    #: 行为观察（T2.1c）单独一段的预算；0 = 不注入（仍会照常记录到库里）
    observation_budget_tokens: int = DEFAULT_OBSERVATION_BUDGET_TOKENS
    history_budget_tokens: int = DEFAULT_HISTORY_BUDGET_TOKENS
    summary_trigger_messages: int = DEFAULT_SUMMARY_TRIGGER_MESSAGES
    summary_trigger_tokens: int = DEFAULT_SUMMARY_TRIGGER_TOKENS
    summary_batch_messages: int = DEFAULT_SUMMARY_BATCH_MESSAGES
    l1_aggregate_summaries: int = DEFAULT_L1_AGGREGATE_SUMMARIES
    l2_aggregate_summaries: int = DEFAULT_L2_AGGREGATE_SUMMARIES
    episode_limit: int = DEFAULT_EPISODE_LIMIT
    impression_messages: int = DEFAULT_IMPRESSION_MESSAGES
    decay_half_life_days: float = DECAY_HALF_LIFE_DAYS
    #: 行为记忆总开关（T2.1c）：关掉就不再派生观察，并清掉已派生的条目
    behavior_enabled: bool = True
    #: 原文 / 低重要度事实的保留天数；0 = 不自动清理
    retention_days: float = DEFAULT_RETENTION_DAYS
    #: 达到这个重要度的记忆永久保留
    permanent_importance: float = DEFAULT_PERMANENT_IMPORTANCE


@dataclass(frozen=True, slots=True)
class Settings:
    """一次启动用到的全部配置（不可变，避免运行期被偷偷改掉）。"""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    data_dir: Path = DEFAULT_DATA_DIR
    characters_dir: Path = DEFAULT_CHARACTERS_DIR
    log_level: str = DEFAULT_LOG_LEVEL
    log_max_bytes: int = DEFAULT_LOG_MAX_BYTES
    log_retention_days: int = DEFAULT_LOG_RETENTION_DAYS
    llm: LlmSettings = LlmSettings()
    asr: AsrSettings = AsrSettings()
    tts: TtsSettings = TtsSettings()
    memory: MemorySettings = MemorySettings()
    vision: VisionSettings = VisionSettings()

    @property
    def runtime_file(self) -> Path:
        """Electron 与 sidecar 的握手文件路径（需求 §6.10）。"""
        return self.data_dir / RUNTIME_FILE_NAME

    @property
    def log_file(self) -> Path:
        """结构化日志文件（<数据目录>/logs/deskpet.log）。"""
        return self.data_dir / LOG_DIR_NAME / LOG_FILE_NAME

    @property
    def usage_db_file(self) -> Path:
        """使用统计库（<数据目录>/usage.db，需求 §6.9）。"""
        return self.data_dir / USAGE_DB_NAME

    @property
    def memory_db_file(self) -> Path:
        """记忆库（<数据目录>/memories.db，需求 §6.4）。"""
        return self.data_dir / MEMORY_DB_NAME

    @property
    def memory_key_file(self) -> Path:
        """记忆库密钥（<数据目录>/key.blob，需求 §6.5）。"""
        return self.data_dir / MEMORY_KEY_NAME


def _positive_int(source: Mapping[str, str], key: str, default: int) -> int:
    """读一个正整数环境变量；非法值直接抛错（配错了要说出来，不要静默用默认值）。"""
    raw = source.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(key + " 不是整数：" + repr(raw)) from exc
    if value <= 0:
        raise ValueError(key + " 必须为正整数：" + raw)
    return value


def _non_negative_int(source: Mapping[str, str], key: str, default: int) -> int:
    """读一个非负整数环境变量：0 是合法值（记忆预算里表示「这一层不注入」）。"""
    raw = source.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(key + " 不是整数：" + repr(raw)) from exc
    if value < 0:
        raise ValueError(key + " 不能为负数：" + raw)
    return value


def _positive_float(source: Mapping[str, str], key: str, default: float) -> float:
    """读一个正浮点环境变量；非法值直接抛错（与 _positive_int 同样的理由）。"""
    raw = source.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(key + " 不是数字：" + repr(raw)) from exc
    if value <= 0:
        raise ValueError(key + " 必须为正数：" + raw)
    return value


def _non_negative_float(source: Mapping[str, str], key: str, default: float) -> float:
    raw = source.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(key + " 不是数字：" + repr(raw)) from exc
    if value < 0:
        raise ValueError(key + " 不能为负数：" + raw)
    return value


def _unit_float(source: Mapping[str, str], key: str, default: float) -> float:
    value = _non_negative_float(source, key, default)
    if value > 1:
        raise ValueError(key + " 必须在 0 到 1 之间：" + repr(value))
    return value


def _delay_list(
    source: Mapping[str, str], key: str, default: tuple[float, ...]
) -> tuple[float, ...]:
    """读「逗号分隔的秒数」——退避序列；空值表示不重试。"""
    raw = source.get(key, "").strip()
    if not raw:
        return default
    delays: list[float] = []
    for piece in raw.split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            value = float(piece)
        except ValueError as exc:
            raise ValueError(key + " 含非数字项：" + repr(piece)) from exc
        if value < 0:
            raise ValueError(key + " 不能为负数：" + piece)
        delays.append(value)
    return tuple(delays)


def _load_llm_settings(source: Mapping[str, str]) -> LlmSettings:
    """读 LLM 三件套与超时/退避参数（键名与仓库根 .env.example 一致）。"""
    return LlmSettings(
        base_url=source.get("DESKPET_LLM_BASE_URL", "").strip(),
        api_key=source.get("DESKPET_LLM_API_KEY", "").strip(),
        model=source.get("DESKPET_LLM_MODEL", "").strip(),
        fallback_base_url=source.get("DESKPET_LLM_FALLBACK_BASE_URL", "").strip(),
        fallback_model=source.get("DESKPET_LLM_FALLBACK_MODEL", "").strip(),
        first_token_timeout_s=_positive_float(
            source, "DESKPET_LLM_FIRST_TOKEN_TIMEOUT_S", DEFAULT_LLM_FIRST_TOKEN_TIMEOUT_S
        ),
        total_timeout_s=_positive_float(
            source, "DESKPET_LLM_TOTAL_TIMEOUT_S", DEFAULT_LLM_TOTAL_TIMEOUT_S
        ),
        retry_delays_s=_delay_list(
            source, "DESKPET_LLM_RETRY_DELAYS_S", DEFAULT_LLM_RETRY_DELAYS_S
        ),
        provider=_provider_value(source, "DESKPET_LLM_PROVIDER", PROVIDER_CLOUD, LLM_PROVIDERS),
        local_base_url=source.get("DESKPET_LLM_LOCAL_BASE_URL", "").strip(),
        local_api_key=source.get("DESKPET_LLM_LOCAL_API_KEY", "").strip(),
        local_model=source.get("DESKPET_LLM_LOCAL_MODEL", "").strip(),
    )


def _bool_flag(source: Mapping[str, str], key: str, default: bool) -> bool:
    """读一个开关：1/true/yes/on 为真，0/false/no/off 为假，其它值直接抛错。"""
    raw = source.get(key, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(key + " 不是开关值（1/0/true/false）：" + repr(raw))


def _provider_value(
    source: Mapping[str, str], key: str, default: str, allowed: tuple[str, ...] = PROVIDERS
) -> str:
    """读模型供给层的 provider 选择：只认该能力面允许的值，写错直接抛错。

    静默回落默认值会让「我明明配了本地，为什么还走云端」极难查（与 _bool_flag 同理）。
    允许集合按能力面分开：LLM 只有 cloud / local，ASR 多一个 cloud，TTS 还有 edge。
    """
    raw = source.get(key, "").strip().lower()
    if not raw:
        return default
    if raw not in allowed:
        raise ValueError(key + " 只能是 " + " / ".join(allowed) + "：" + repr(raw))
    return raw


def _load_asr_settings(source: Mapping[str, str], data_dir: Path) -> AsrSettings:
    """读 ASR 配置（键名与仓库根 .env.example 一致）。

    model_dir 默认跟着数据目录走：打包态数据目录在 userData 下，模型缓存也应当一起搬。
    """
    raw_model_dir = source.get("DESKPET_ASR_MODEL_DIR", "").strip()
    raw_stream_dir = source.get("DESKPET_ASR_STREAM_MODEL_DIR", "").strip()
    return AsrSettings(
        model=source.get("DESKPET_ASR_MODEL", DEFAULT_ASR_MODEL).strip() or DEFAULT_ASR_MODEL,
        device=source.get("DESKPET_ASR_DEVICE", DEFAULT_ASR_DEVICE).strip() or DEFAULT_ASR_DEVICE,
        compute_type=source.get("DESKPET_ASR_COMPUTE_TYPE", DEFAULT_ASR_COMPUTE_TYPE).strip()
        or DEFAULT_ASR_COMPUTE_TYPE,
        model_dir=Path(raw_model_dir) if raw_model_dir else data_dir / ASR_MODEL_DIR_NAME,
        language=source.get("DESKPET_ASR_LANGUAGE", "").strip(),
        beam_size=_positive_int(source, "DESKPET_ASR_BEAM_SIZE", DEFAULT_ASR_BEAM_SIZE),
        timeout_s=_positive_float(source, "DESKPET_ASR_TIMEOUT_S", DEFAULT_ASR_TIMEOUT_S),
        vad_filter=_bool_flag(source, "DESKPET_ASR_VAD", True),
        hf_endpoint=source.get("DESKPET_ASR_HF_ENDPOINT", "").strip(),
        provider=_provider_value(source, "DESKPET_ASR_PROVIDER", PROVIDER_LOCAL, ASR_PROVIDERS),
        cloud_base_url=source.get("DESKPET_ASR_CLOUD_BASE_URL", "").strip(),
        cloud_api_key=source.get("DESKPET_ASR_CLOUD_API_KEY", "").strip(),
        cloud_model=source.get("DESKPET_ASR_CLOUD_MODEL", DEFAULT_ASR_CLOUD_MODEL).strip()
        or DEFAULT_ASR_CLOUD_MODEL,
        streaming_enabled=_bool_flag(source, "DESKPET_ASR_STREAMING", True),
        stream_model_dir=(
            Path(raw_stream_dir) if raw_stream_dir else data_dir / ASR_STREAM_MODEL_DIR_NAME
        ),
        stream_threads=_positive_int(
            source, "DESKPET_ASR_STREAM_THREADS", DEFAULT_ASR_STREAM_THREADS
        ),
    )


def _load_tts_settings(source: Mapping[str, str]) -> TtsSettings:
    """读 TTS 适配器配置（键名与仓库根 .env.example 一致）。"""
    return TtsSettings(
        base_url=source.get("DESKPET_TTS_URL", DEFAULT_TTS_URL).strip() or DEFAULT_TTS_URL,
        token=source.get("DESKPET_TTS_TOKEN", "").strip(),
        timeout_s=_positive_float(source, "DESKPET_TTS_TIMEOUT_S", DEFAULT_TTS_TIMEOUT_S),
        provider=_provider_value(source, "DESKPET_TTS_PROVIDER", PROVIDER_LOCAL, TTS_PROVIDERS),
        edge_voice=source.get("DESKPET_TTS_EDGE_VOICE", DEFAULT_TTS_EDGE_VOICE).strip()
        or DEFAULT_TTS_EDGE_VOICE,
        edge_rate=source.get("DESKPET_TTS_EDGE_RATE", "").strip(),
        edge_pitch=source.get("DESKPET_TTS_EDGE_PITCH", "").strip(),
    )


def _load_vision_settings(source: Mapping[str, str]) -> VisionSettings:
    return VisionSettings(
        base_url=source.get("DESKPET_VISION_BASE_URL", DEFAULT_VISION_BASE_URL).strip()
        or DEFAULT_VISION_BASE_URL,
        model=source.get("DESKPET_VISION_MODEL", DEFAULT_VISION_MODEL).strip(),
        api_key=source.get("DESKPET_VISION_API_KEY", "").strip(),
        timeout_s=_positive_float(source, "DESKPET_VISION_TIMEOUT_S", DEFAULT_VISION_TIMEOUT_S),
        max_image_bytes=_positive_int(
            source, "DESKPET_VISION_MAX_IMAGE_BYTES", DEFAULT_VISION_MAX_IMAGE_BYTES
        ),
    )


def _load_memory_settings(source: Mapping[str, str]) -> MemorySettings:
    """读记忆系统的预算与阈值（键名与仓库根 .env.example 一致）。"""
    return MemorySettings(
        history_turns=_non_negative_int(
            source, "DESKPET_MEMORY_HISTORY_TURNS", DEFAULT_RECENT_TURNS
        ),
        recall_limit=_non_negative_int(source, "DESKPET_MEMORY_RECALL_LIMIT", DEFAULT_RECALL_LIMIT),
        l3_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_L3_BUDGET_TOKENS", DEFAULT_L3_BUDGET_TOKENS
        ),
        l2_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_L2_BUDGET_TOKENS", DEFAULT_L2_BUDGET_TOKENS
        ),
        l1_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_L1_BUDGET_TOKENS", DEFAULT_L1_BUDGET_TOKENS
        ),
        recall_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_RECALL_BUDGET_TOKENS", DEFAULT_RECALL_BUDGET_TOKENS
        ),
        history_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_HISTORY_BUDGET_TOKENS", DEFAULT_HISTORY_BUDGET_TOKENS
        ),
        observation_budget_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_OBSERVATION_BUDGET_TOKENS", DEFAULT_OBSERVATION_BUDGET_TOKENS
        ),
        behavior_enabled=_bool_flag(source, "DESKPET_MEMORY_BEHAVIOR_ENABLED", True),
        retention_days=_non_negative_float(
            source, "DESKPET_MEMORY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS
        ),
        permanent_importance=_unit_float(
            source, "DESKPET_MEMORY_PERMANENT_IMPORTANCE", DEFAULT_PERMANENT_IMPORTANCE
        ),
        summary_trigger_messages=_non_negative_int(
            source, "DESKPET_MEMORY_SUMMARY_TRIGGER_MESSAGES", DEFAULT_SUMMARY_TRIGGER_MESSAGES
        ),
        summary_trigger_tokens=_non_negative_int(
            source, "DESKPET_MEMORY_SUMMARY_TRIGGER_TOKENS", DEFAULT_SUMMARY_TRIGGER_TOKENS
        ),
        summary_batch_messages=_non_negative_int(
            source, "DESKPET_MEMORY_SUMMARY_BATCH_MESSAGES", DEFAULT_SUMMARY_BATCH_MESSAGES
        ),
        l1_aggregate_summaries=_non_negative_int(
            source, "DESKPET_MEMORY_L1_AGGREGATE_SUMMARIES", DEFAULT_L1_AGGREGATE_SUMMARIES
        ),
        l2_aggregate_summaries=_non_negative_int(
            source, "DESKPET_MEMORY_L2_AGGREGATE_SUMMARIES", DEFAULT_L2_AGGREGATE_SUMMARIES
        ),
        episode_limit=_non_negative_int(
            source, "DESKPET_MEMORY_EPISODE_LIMIT", DEFAULT_EPISODE_LIMIT
        ),
        impression_messages=_non_negative_int(
            source, "DESKPET_MEMORY_IMPRESSION_MESSAGES", DEFAULT_IMPRESSION_MESSAGES
        ),
        decay_half_life_days=_positive_float(
            source, "DESKPET_MEMORY_DECAY_HALF_LIFE_DAYS", DECAY_HALF_LIFE_DAYS
        ),
    )


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """从环境变量读配置。

    端口非法时直接抛错：宁可启动失败并让 Electron 报「sidecar 起不来」，
    也不要静默落到一个用户没配过的端口上（那种问题在真机上极难排查）。
    """
    source = os.environ if env is None else env
    raw_port = source.get("DESKPET_SIDECAR_PORT", str(DEFAULT_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError("DESKPET_SIDECAR_PORT 不是整数：" + repr(raw_port)) from exc
    if not 0 <= port <= 65535:
        raise ValueError("DESKPET_SIDECAR_PORT 超出 0-65535：" + raw_port)
    raw_data_dir = source.get("DESKPET_DATA_DIR", "").strip()
    raw_characters_dir = source.get("DESKPET_CHARACTERS_DIR", "").strip()
    data_dir = Path(raw_data_dir) if raw_data_dir else DEFAULT_DATA_DIR
    return Settings(
        host=source.get("DESKPET_SIDECAR_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=port,
        data_dir=data_dir,
        characters_dir=(Path(raw_characters_dir) if raw_characters_dir else DEFAULT_CHARACTERS_DIR),
        log_level=source.get("DESKPET_LOG_LEVEL", DEFAULT_LOG_LEVEL).strip().lower()
        or DEFAULT_LOG_LEVEL,
        log_max_bytes=_positive_int(source, "DESKPET_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES),
        log_retention_days=_positive_int(
            source, "DESKPET_LOG_RETENTION_DAYS", DEFAULT_LOG_RETENTION_DAYS
        ),
        llm=_load_llm_settings(source),
        asr=_load_asr_settings(source, data_dir),
        tts=_load_tts_settings(source),
        memory=_load_memory_settings(source),
        vision=_load_vision_settings(source),
    )
