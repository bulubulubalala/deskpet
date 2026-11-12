"""文件职责：判断一个 URL 是否指向本机（决定要不要绕过系统代理）。

为什么需要：Windows 开了系统代理时，httpx 会默认把 127.0.0.1 的本地 TTS / Ollama /
云端 ASR 也发给代理，结果是「本地服务明明在跑，却收到 502」。本机地址永远不该走代理。
"""

from __future__ import annotations

from urllib.parse import urlsplit


def is_loopback_url(url: str) -> bool:
    """localhost / 127.0.0.0/8 / [::1] 都算本机；解析不了就当不是。"""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "localhost" or host == "::1" or host.startswith("127.")
