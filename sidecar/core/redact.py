"""文件职责：把错误详情里的密钥形态盖掉、截断长文本、清洗端点地址（D6 / 错误排查）。

为什么单独一个模块：错误详情会同时进界面弹窗、主进程日志与「复制诊断信息」，
脱敏必须在离开 sidecar 之前做一次；纯函数也便于用单测钉住「sk-xxx 绝不能漏」。

与 TS 侧的关系：app/main/diagnostics.ts 的 redactSecrets 是第二道兜底，两边规则要保持
同一套（key、Bearer、token 查询串）。这里不 import 任何业务模块，只做字符串处理。
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

#: 错误响应体最多带这么多字符进事件/日志；服务商有时回整页 HTML，截断才看得清。
MAX_ERROR_BODY_CHARS = 2048
#: 技术原文最多这么多字符；一般是一行，超过说明端点回了长文。
MAX_ERROR_MESSAGE_CHARS = 500

_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # OpenAI / DeepSeek 等常见的 sk- key
    (re.compile(r"sk-[A-Za-z0-9_-]{6,}"), "sk-***"),
    # Authorization: Bearer xxx
    (re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]{6,}=*", re.IGNORECASE), "Bearer ***"),
    # JSON 形状：{"api_key": "xxx"}——键名两侧带引号，单靠下面的通用规则会漏掉
    (
        re.compile(
            r"(\"(?:token|api[_-]?key|authorization|secret|password)\"\s*:\s*\")([^\"]{4,})(\")",
            re.IGNORECASE,
        ),
        r"\1***\3",
    ),
    # token=xxx / api_key: xxx / authorization=xxx（保留字段名，只盖值）
    (
        re.compile(
            r"(token|api[_-]?key|authorization|secret|password)(\s*[=:]\s*\"?)([^\"\s,}]{4,})",
            re.IGNORECASE,
        ),
        r"\1\2***",
    ),
    # URL 查询串里的 ?token=... / &key=...
    (re.compile(r"([?&](?:token|key)=)[^&\s\"]+", re.IGNORECASE), r"\1***"),
)


def redact_secrets(text: str) -> str:
    """把一段文本里的密钥形态替换掉；宁可多盖，不可漏盖。"""
    result = text
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def clip_text(text: str, max_chars: int) -> str:
    """按字符数截断并加省略号；保证返回值长度不超过 max_chars。"""
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars == 1:
        return "…"
    return text[: max_chars - 1] + "…"


def safe_endpoint(raw: str) -> str:
    """只留 scheme://host[:port]/path，去掉 userinfo、query、fragment（可能含密钥）。"""
    text = raw.strip()
    if text == "":
        return ""
    try:
        parts = urlsplit(text)
    except ValueError:
        return clip_text(redact_secrets(text.split("?", 1)[0]), 300)
    if parts.scheme == "" or parts.netloc == "":
        # 不是绝对 URL（例如本地适配器只给了 host:port）：保留到 query 之前即可
        return clip_text(redact_secrets(text.split("?", 1)[0]), 300)
    host = parts.hostname or ""
    if ":" in host and not host.startswith("["):
        host = "[" + host + "]"
    try:
        port = ":" + str(parts.port) if parts.port is not None else ""
    except ValueError:
        port = ""
    return parts.scheme + "://" + host + port + (parts.path or "")
