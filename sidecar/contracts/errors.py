"""文件职责：跨边界的错误信封（HTTP 与 IPC 共用的失败形状）。

依赖方向：只依赖 pydantic。
谁调用：api/stubs.py 的 501 桩、api/auth.py 的 401、T0.4 起的统一异常处理器。
说明：完整错误码注册表在 T0.4 落地，本模块先钉死「边界上长什么样」（CODE_STYLE §6.1）。
"""

from pydantic import BaseModel, Field

ERROR_CODE_PATTERN = r"^DP-(LLM|ASR|TTS|MEM|SCR|DEV|STAGE|PACK|SYS)-[0-9]{3}$"

# 边界层专用错误码：M0 只有 GET /health 是真实现（见 contracts/routes.py）
CODE_NOT_IMPLEMENTED = "DP-SYS-501"
CODE_INTERNAL = "DP-SYS-500"
CODE_UNAUTHORIZED = "DP-SYS-401"


class ErrorEnvelope(BaseModel):
    """边界上的失败信封：code / message 给日志排查，user_hint 给用户看（CODE_STYLE §6）。"""

    code: str = Field(pattern=ERROR_CODE_PATTERN, examples=["DP-SYS-501"])
    message: str = Field(description="机器可读的详情，可含技术细节")
    user_hint: str | None = Field(
        default=None,
        description="给用户看的文案；None 表示无需打扰用户",
    )
