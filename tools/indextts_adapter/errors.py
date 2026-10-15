r"""文件职责：适配器对外报错的类型，以及错误码 → HTTP 状态码的映射。

依赖方向：被 engine / worker / http_api 导入，本身不依赖本包任何其他模块。
错误码沿用 deskpet 的 DP-TTS 域（CODE_STYLE §6.1）——最后三位就是 HTTP 状态码。
"""

from __future__ import annotations

__all__ = ["AdapterError", "status_for"]


class AdapterError(Exception):
    """适配器对外报错用的异常。code 取自 DP-TTS 域错误码表（CODE_STYLE §6.1）。"""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def to_dict(self) -> dict[str, str]:
        body = {"code": self.code, "message": self.message}
        if self.hint:
            # hint 是给用户看的排查指引（D14：引擎坏了原样呈现，不猜原因、不替用户修）
            body["hint"] = self.hint
        return body


def status_for(code: str) -> int:
    """错误码最后三位就是 HTTP 状态码（CODE_STYLE §6.1）；解析不出来按 500 算。"""
    try:
        return int(code.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 500
