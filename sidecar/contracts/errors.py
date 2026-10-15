"""文件职责：错误信封与错误码注册表（HTTP 与 IPC 共用的失败形状）。

依赖方向：只依赖标准库与 pydantic；谁都可以 import 它，它不 import 任何业务模块。
谁调用：api/stubs.py 的 501 桩、api/auth.py 的 401、api/error_handlers.py 的统一处理器、
core/errors.py（异常类构造时校验自己的 code 属于哪个域）。
约定（CODE_STYLE §6.4）：错误码只在边界层（HTTP / IPC）出现在响应里，内部一律抛异常类型，
日志里两者都记。新增错误码必须同步本文件与 CODE_STYLE §6.4。
"""

from __future__ import annotations

import re
from enum import StrEnum

from pydantic import BaseModel, Field


class ErrorDomain(StrEnum):
    """错误码的域——DP-域-三位 中间那一段（CODE_STYLE §6.4）。"""

    LLM = "LLM"
    ASR = "ASR"
    TTS = "TTS"
    MEM = "MEM"
    SCR = "SCR"
    DEV = "DEV"
    STAGE = "STAGE"
    PACK = "PACK"
    SYS = "SYS"


# 正则给 Pydantic / 外部（TS 侧）校验用，ErrorDomain 给 Python 代码用；两者由契约测试对账。
ERROR_CODE_PATTERN = r"^DP-(LLM|ASR|TTS|MEM|SCR|DEV|STAGE|PACK|SYS)-[0-9]{3}$"
_CODE_RE = re.compile(r"^DP-(?P<domain>[A-Z]+)-(?P<number>[0-9]{3})$")


def domain_of(code: str) -> ErrorDomain:
    """取出错误码的域；格式或域不对就抛 ValueError（写错码比没码更难查）。"""
    matched = _CODE_RE.fullmatch(code)
    if matched is None:
        raise ValueError("错误码格式不对（应为 DP-域-三位）：" + repr(code))
    try:
        return ErrorDomain(matched["domain"])
    except ValueError as exc:
        raise ValueError("未知错误码域：" + repr(code)) from exc


# --- 错误码注册表（M0 冻结）---------------------------------------------
# 每一项都是一种「可预期的失败」，来自需求 §6.7 与 CODE_STYLE §6.4 的域表。
# LLM（云端）
CODE_LLM_AUTH_FAILED = "DP-LLM-001"
CODE_LLM_RATE_LIMITED = "DP-LLM-002"
CODE_LLM_TIMEOUT = "DP-LLM-003"
CODE_LLM_BAD_RESPONSE = "DP-LLM-004"
# ASR（faster-whisper，本地）
CODE_ASR_DEVICE_BUSY = "DP-ASR-001"
CODE_ASR_TIMEOUT = "DP-ASR-002"
CODE_ASR_EMPTY_RESULT = "DP-ASR-003"
#: T1.4 新增：组件未安装 / 模型缺失 / 模型加载失败（缺模型必须给排查指引，§6.7）
CODE_ASR_UNAVAILABLE = "DP-ASR-004"
#: T1.4 新增：音频本身不合法（空请求体、长度不足一个采样点、超过 4 MiB 上限）
CODE_ASR_BAD_AUDIO = "DP-ASR-005"
# TTS（IndexTTS，外部引擎：本项目只调用、不运维，D14）
CODE_TTS_ENGINE_NOT_LOADED = "DP-TTS-001"
CODE_TTS_SENTENCE_TIMEOUT = "DP-TTS-002"
CODE_TTS_SYNTHESIS_FAILED = "DP-TTS-003"
# 记忆（SQLite + SQLCipher）
CODE_MEM_KEY_INVALID = "DP-MEM-001"
CODE_MEM_READONLY_FALLBACK = "DP-MEM-002"
CODE_MEM_INDEX_BROKEN = "DP-MEM-003"
# 屏幕（截屏 + OCR）
CODE_SCR_CAPTURE_FAILED = "DP-SCR-001"
CODE_SCR_OCR_FAILED = "DP-SCR-002"
CODE_SCR_PERMISSION_DENIED = "DP-SCR-003"
# 设备（麦克风 / 扬声器）
CODE_DEV_MIC_UNAVAILABLE = "DP-DEV-001"
CODE_DEV_SPEAKER_UNAVAILABLE = "DP-DEV-002"
# 形象（Stage：Live2D / PNG）
CODE_STAGE_MODEL_MISSING = "DP-STAGE-001"
CODE_STAGE_ASSET_MISSING = "DP-STAGE-002"
# 角色包
CODE_PACK_FIELD_MISSING = "DP-PACK-001"
CODE_PACK_ASSET_UNDECODABLE = "DP-PACK-002"
# 系统与边界层
CODE_UNAUTHORIZED = "DP-SYS-401"
CODE_INTERNAL = "DP-SYS-500"
CODE_NOT_IMPLEMENTED = "DP-SYS-501"
CODE_SIDECAR_OFFLINE = "DP-SYS-502"
CODE_RESTART_LIMIT_REACHED = "DP-SYS-503"
CODE_VERSION_MISMATCH = "DP-SYS-504"

#: 全量列表，供契约测试逐条对账（正则 + 域）；新增错误码必须同时加进来。
ERROR_CODES: tuple[str, ...] = (
    CODE_LLM_AUTH_FAILED,
    CODE_LLM_RATE_LIMITED,
    CODE_LLM_TIMEOUT,
    CODE_LLM_BAD_RESPONSE,
    CODE_ASR_DEVICE_BUSY,
    CODE_ASR_TIMEOUT,
    CODE_ASR_EMPTY_RESULT,
    CODE_ASR_UNAVAILABLE,
    CODE_ASR_BAD_AUDIO,
    CODE_TTS_ENGINE_NOT_LOADED,
    CODE_TTS_SENTENCE_TIMEOUT,
    CODE_TTS_SYNTHESIS_FAILED,
    CODE_MEM_KEY_INVALID,
    CODE_MEM_READONLY_FALLBACK,
    CODE_MEM_INDEX_BROKEN,
    CODE_SCR_CAPTURE_FAILED,
    CODE_SCR_OCR_FAILED,
    CODE_SCR_PERMISSION_DENIED,
    CODE_DEV_MIC_UNAVAILABLE,
    CODE_DEV_SPEAKER_UNAVAILABLE,
    CODE_STAGE_MODEL_MISSING,
    CODE_STAGE_ASSET_MISSING,
    CODE_PACK_FIELD_MISSING,
    CODE_PACK_ASSET_UNDECODABLE,
    CODE_UNAUTHORIZED,
    CODE_INTERNAL,
    CODE_NOT_IMPLEMENTED,
    CODE_SIDECAR_OFFLINE,
    CODE_RESTART_LIMIT_REACHED,
    CODE_VERSION_MISMATCH,
)


class ErrorEnvelope(BaseModel):
    """边界上的失败信封：code / message 给日志排查，user_hint 给用户看（CODE_STYLE §6）。"""

    code: str = Field(pattern=ERROR_CODE_PATTERN, examples=["DP-SYS-501"])
    message: str = Field(description="机器可读的详情，可含技术细节")
    user_hint: str | None = Field(
        default=None,
        description="给用户看的文案；None 表示无需打扰用户",
    )
