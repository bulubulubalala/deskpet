"""文件职责：HTTP 边界的回环 token 校验（需求 §6.10）。

依赖方向：api -> contracts（错误信封）；不 import services / adapters。
谁调用：app.py 的 create_app(token=...) 挂成最外层中间件。
为什么需要：sidecar 监听 127.0.0.1，本机任何进程（包括浏览器里的网页）都能访问它；
token 每次启动重新生成、只写在 data/runtime.json 里，挡住「别的程序乱调 TTS / LLM」。
"""

import secrets
from http import HTTPStatus

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from contracts.errors import CODE_UNAUTHORIZED, ErrorEnvelope

TOKEN_HEADER = "X-Deskpet-Token"


class TokenAuthMiddleware:
    """只要请求没带对的 token 就回 401 + 统一错误信封；WebSocket 等非 HTTP 请求不拦。"""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        provided = Headers(scope=scope).get(TOKEN_HEADER, "")
        # compare_digest：比较耗时与内容无关，避免用计时差猜 token（本机场景也照做）
        if not secrets.compare_digest(provided, self.token):
            envelope = ErrorEnvelope(
                code=CODE_UNAUTHORIZED,
                message="缺少或错误的 " + TOKEN_HEADER,
                user_hint=None,
            )
            response = JSONResponse(
                status_code=int(HTTPStatus.UNAUTHORIZED),
                content=envelope.model_dump(mode="json"),
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
