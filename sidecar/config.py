"""文件职责：sidecar 运行时配置（CODE_STYLE §1.6：可调参数集中于此）。

依赖方向：只依赖标准库，不 import 任何业务模块。
谁调用：sidecar/main.py 启动时读一次；测试用 load_settings(env={...}) 注入。
约定：这里的默认值必须与仓库根 .env.example 保持一致。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

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
#: 需求 §6.12 / D14：常驻 TTS 适配器由用户自己部署，本项目只调用它
DEFAULT_TTS_URL = "http://127.0.0.1:8742"
#: 需求 §6.7：单句合成预算 30s（超时只跳过这一句，不打断整轮对话）
DEFAULT_TTS_TIMEOUT_S = 30.0
#: 模型缓存目录名（相对数据目录）；模型不进安装包，首次使用时下载到这里
ASR_MODEL_DIR_NAME = "models/asr"
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


@dataclass(frozen=True, slots=True)
class LlmSettings:
    """云端 LLM 的接入配置（§2 D2：模型在云端，密钥只留在本机 .env）。

    主端点为空表示「还没配」——服务层据此给出明确提示，而不是默默不发请求。
    备用端点是 §6.7 的第二层降级；它的模型名留空时沿用主端点的模型名。
    """

    base_url: str = ""
    api_key: str = ""
    model: str = ""
    fallback_base_url: str = ""
    fallback_model: str = ""
    first_token_timeout_s: float = DEFAULT_LLM_FIRST_TOKEN_TIMEOUT_S
    total_timeout_s: float = DEFAULT_LLM_TOTAL_TIMEOUT_S
    retry_delays_s: tuple[float, ...] = DEFAULT_LLM_RETRY_DELAYS_S


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


@dataclass(frozen=True, slots=True)
class TtsSettings:
    """常驻 TTS 适配器的接入配置（需求 §6.12 / 决策 D14）。

    base_url 指**用户自己部署**的适配器进程（默认 127.0.0.1:8742），不是 IndexTTS 本体；
    token 是适配器的共享口令（可空）；timeout_s 是单句预算（§6.7 的 30s）。
    适配器侧还有自己的排队超时（默认 120s），两段时间是各管一段的。
    """

    base_url: str = DEFAULT_TTS_URL
    token: str = ""
    timeout_s: float = DEFAULT_TTS_TIMEOUT_S


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

    @property
    def runtime_file(self) -> Path:
        """Electron 与 sidecar 的握手文件路径（需求 §6.10）。"""
        return self.data_dir / RUNTIME_FILE_NAME

    @property
    def log_file(self) -> Path:
        """结构化日志文件（<数据目录>/logs/deskpet.log）。"""
        return self.data_dir / LOG_DIR_NAME / LOG_FILE_NAME


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


def _load_asr_settings(source: Mapping[str, str], data_dir: Path) -> AsrSettings:
    """读 ASR 配置（键名与仓库根 .env.example 一致）。

    model_dir 默认跟着数据目录走：打包态数据目录在 userData 下，模型缓存也应当一起搬。
    """
    raw_model_dir = source.get("DESKPET_ASR_MODEL_DIR", "").strip()
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
    )


def _load_tts_settings(source: Mapping[str, str]) -> TtsSettings:
    """读 TTS 适配器配置（键名与仓库根 .env.example 一致）。"""
    return TtsSettings(
        base_url=source.get("DESKPET_TTS_URL", DEFAULT_TTS_URL).strip() or DEFAULT_TTS_URL,
        token=source.get("DESKPET_TTS_TOKEN", "").strip(),
        timeout_s=_positive_float(source, "DESKPET_TTS_TIMEOUT_S", DEFAULT_TTS_TIMEOUT_S),
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
    )
