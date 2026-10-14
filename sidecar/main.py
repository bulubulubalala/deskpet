"""文件职责：sidecar 的进程入口（launcher）——选端口、起 uvicorn、维护 runtime.json。

依赖方向：本文件是组合根的一部分，可 import api / adapters / contracts / config。
谁调用：开发态 python sidecar/main.py；打包态由 Electron 拉起 sidecar.exe（T0.8/T0.9）。

启动顺序（需求 §6.10，顺序本身就是契约）：
1) 先 bind + listen，确定真实端口（首选端口被占用就退回系统分配）；
2) 端口定下来后才写 data/runtime.json —— Electron 只有看到文件才敢发请求；
3) 把已 listen 的 socket 交给 uvicorn（不再二次 bind）；
4) 正常退出时删除 runtime.json（被强杀时由 Electron 兜底清理）。

为什么拆成 launch / serve 两步：契约测试要在同一个进程里起真实服务器、发真实 HTTP 请求，
再让 server.should_exit 触发优雅退出，从而验证「起来→握手→退出即删」整条链路（不需要 GPU）。
"""

from __future__ import annotations

import os
import secrets
import socket
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import uvicorn

from adapters.runtime_file import remove_runtime_file, write_runtime_file
from adapters.socket_binding import bind_listening_socket
from app import create_app
from config import Settings, load_settings
from contracts.routes import SERVICE_VERSION
from contracts.runtime import RuntimeInfo

TOKEN_BYTES = 32


@dataclass(frozen=True, slots=True)
class LaunchedSidecar:
    """启动准备的产物：端口已 listen、runtime.json 已写、server 随时可 run。"""

    server: uvicorn.Server
    listening_socket: socket.socket
    info: RuntimeInfo
    runtime_file: Path


def _utc_now_iso() -> str:
    """启动时间的 ISO 8601（UTC，秒精度）——写进 runtime.json 方便排查陈旧进程。"""
    return datetime.now(UTC).isoformat(timespec="seconds")


def launch(settings: Settings | None = None) -> LaunchedSidecar:
    """绑定端口、生成 token、写好 runtime.json，返回可直接 run 的服务器（本函数不阻塞）。"""
    resolved = settings or load_settings()
    token = secrets.token_hex(TOKEN_BYTES)
    sock, port = bind_listening_socket(resolved.host, resolved.port)
    runtime_file = resolved.runtime_file
    info = RuntimeInfo(
        pid=os.getpid(),
        host=resolved.host,
        port=port,
        token=token,
        started_at=_utc_now_iso(),
        version=SERVICE_VERSION,
    )
    write_runtime_file(runtime_file, info)
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(token=token),
            host=resolved.host,
            port=port,
            log_level=resolved.log_level,
            access_log=False,
        )
    )
    return LaunchedSidecar(
        server=server,
        listening_socket=sock,
        info=info,
        runtime_file=runtime_file,
    )


def serve(launched: LaunchedSidecar) -> None:
    """跑 uvicorn 直到停止；无论怎么退出都删掉 runtime.json（唯一的清理点）。"""
    try:
        launched.server.run(sockets=[launched.listening_socket])
    finally:
        remove_runtime_file(launched.runtime_file)


def run(settings: Settings | None = None) -> int:
    """生产入口：阻塞到收到停止信号，返回进程退出码。"""
    serve(launch(settings))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
