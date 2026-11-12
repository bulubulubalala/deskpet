"""文件职责：给 sidecar 找一个真能监听的端口（需求 §6.10：端口冲突不是启动失败）。

依赖方向：只依赖标准库 socket。
谁调用：sidecar/main.py；测试直接调用（不需要起服务）。
"""

import socket

LISTEN_BACKLOG = 64


def _bind(host: str, port: int) -> socket.socket:
    """建立并 listen 一个 TCP socket；失败时关掉句柄再抛，避免泄漏。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        sock.listen(LISTEN_BACKLOG)
    except OSError:
        sock.close()
        raise
    return sock


def bind_listening_socket(host: str, preferred_port: int) -> tuple[socket.socket, int]:
    """返回（已 listen 的 socket, 实际端口）。

    先试 preferred_port；被占用（或该端口不可用）就退回 0 让系统分配。
    这样「用户机器上 8737 被别的程序占了」不会变成打不开的软件——
    Electron 从 runtime.json 读真实端口，永远不需要猜（需求 §6.10）。
    """
    try:
        sock = _bind(host, preferred_port)
    except OSError:
        sock = _bind(host, 0)
    return sock, int(sock.getsockname()[1])
