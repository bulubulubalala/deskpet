"""文件职责：内部异常类型（CODE_STYLE §1.7）——内部只抛异常，边界才转错误码。

依赖方向：core -> contracts（错误码与信封）；禁止 import adapters / api / services。
谁调用：services 与 core 里所有失败路径；api/error_handlers.py 负责翻译成 HTTP 响应。
命名说明：DP-MEM 与 DP-SYS 的异常类刻意不叫 MemoryError / SystemError —— 那两个是 Python
内建异常名（OOM 处理要 except MemoryError），同名会在 except 处埋雷。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import ClassVar

from contracts.errors import ErrorDomain, ErrorEnvelope, domain_of


class DeskpetError(Exception):
    """所有业务异常的基类：域 + 错误码 + 用户文案 + 结构化上下文。

    构造时就校验 code 的域与异常类声明的域一致：写错域会在测试里立刻炸，
    而不是等到线上日志里出现「TTS 域记了一条 LLM 的失败」。
    """

    domain: ClassVar[ErrorDomain]
    code: str
    message: str
    user_hint: str | None
    context: dict[str, object]

    def __init__(
        self,
        code: str,
        message: str,
        *,
        user_hint: str | None = None,
        context: Mapping[str, object] | None = None,
    ) -> None:
        """code 见 contracts/errors.py 的注册表；message 进日志，user_hint 给用户看。"""
        super().__init__(message)
        if domain_of(code) is not self.domain:
            raise ValueError(f"错误码 {code} 不属于 {self.domain} 域")
        self.code = code
        self.message = message
        self.user_hint = user_hint
        self.context = dict(context) if context else {}

    def to_envelope(self) -> ErrorEnvelope:
        """转成边界上的失败信封（只带 code / message / user_hint，不带内部上下文）。"""
        return ErrorEnvelope(code=self.code, message=self.message, user_hint=self.user_hint)

    def __str__(self) -> str:
        return self.code + " " + self.message


class LlmError(DeskpetError):
    """云端 LLM 失败（DP-LLM）：鉴权、限流、超时、返回体解析失败。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.LLM


class AsrError(DeskpetError):
    """语音识别失败（DP-ASR）：设备占用、识别超时、空结果。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.ASR


class TtsError(DeskpetError):
    """语音合成失败（DP-TTS）：引擎未加载、单句超时、合成失败。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.TTS


class MemoryStoreError(DeskpetError):
    """记忆存取失败（DP-MEM）：密钥失效、只读降级、索引损坏。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.MEM


class ScreenError(DeskpetError):
    """屏幕识别失败（DP-SCR）：截屏失败、OCR 失败、权限被拒。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.SCR


class DeviceError(DeskpetError):
    """音频设备失败（DP-DEV）：麦克风 / 扬声器不可用。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.DEV


class StageError(DeskpetError):
    """形象层失败（DP-STAGE）：Live2D 模型缺失、素材缺失。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.STAGE


class PackError(DeskpetError):
    """角色包失败（DP-PACK）：必填字段缺失、素材不可解码。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.PACK


class SidecarError(DeskpetError):
    """进程/系统级失败（DP-SYS）：离线、重启超限、版本不匹配。"""

    domain: ClassVar[ErrorDomain] = ErrorDomain.SYS
