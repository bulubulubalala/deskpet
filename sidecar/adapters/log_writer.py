"""文件职责：日志的 I/O 部分——单行 JSON 格式化、按大小滚动、按天清理、装配。

依赖方向：adapters -> core（纯逻辑与常量）；不 import api / services。
谁调用：sidecar/main.py 启动时 setup_logging(...)；测试各自建临时目录。
为什么自己写 handler：需求 §6.7 要「滚动保留 7 天 / 20MB」，而标准库的
RotatingFileHandler 只按大小、TimedRotatingFileHandler 只按时间，都不满足两条同时生效。
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from core.logging import ROOT_LOGGER_NAME, format_trace

_LEVEL_ALIASES: dict[str, int] = {
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "fatal": logging.CRITICAL,
}


def _utc_now_iso_ms() -> str:
    """日志时间戳（UTC，毫秒精度）；与 runtime.json 的 +00:00 风格保持一致。"""
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def resolve_level(level: str) -> int:
    """把 .env 里的级别字符串转成 logging 级别；未知值退回 INFO（拼错不该导致不写日志）。"""
    normalized = level.strip().upper()
    if normalized in _LEVEL_ALIASES:
        return _LEVEL_ALIASES[normalized]
    resolved = logging.getLevelName(normalized)
    return resolved if isinstance(resolved, int) else logging.INFO


class JsonLineFormatter(logging.Formatter):
    """一行一个 JSON 对象（CODE_STYLE §6.1）；中文原样输出（ensure_ascii=False）。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": _utc_now_iso_ms(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "dp", None)  # core/logging.log_event 挂上来的业务字段
        if isinstance(extra, Mapping):
            payload.update({str(key): value for key, value in extra.items()})
        exc_info = record.exc_info
        if "trace" not in payload and exc_info is not None:
            exception = exc_info[1]
            if exception is not None:
                payload["trace"] = format_trace(exception)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class RollingJsonLogHandler(logging.Handler):
    """单文件 + 超限改名 + 按天清理的日志 handler（需求 §6.7：7 天 / 20MB）。

    - 单文件写满 max_bytes 就把当前文件改名成 <name>.<UTC 时间戳>，然后重新开始；
    - 每次滚动后删掉 mtime 早于 retention_days 的历史文件，构造时也清一次；
    - 每次 emit 现开现关：日志量级是「每条一个事件」，换来的是不长期握着文件句柄
      （Windows 上句柄被占会让用户删不掉 data/ 目录）。
    """

    def __init__(self, path: Path, *, max_bytes: int, retention_days: int) -> None:
        super().__init__()
        self.path = path
        self.max_bytes = max_bytes
        self.retention_days = retention_days
        self._prune()

    def emit(self, record: logging.LogRecord) -> None:
        """写一行；任何写日志的失败都不许把业务带崩（CODE_STYLE §1.7 允许的兜底）。"""
        try:
            line = self.format(record) + "\n"
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self._would_exceed(line):
                self._roll()
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line)
        except Exception:  # 日志兜底：交给 handleError 记到 stderr
            self.handleError(record)

    def _would_exceed(self, line: str) -> bool:
        if not self.path.exists():
            return False
        return self.path.stat().st_size + len(line.encode("utf-8")) > self.max_bytes

    def _roll(self) -> None:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        target = self.path.with_name(self.path.name + "." + stamp)
        suffix = 1
        while target.exists():  # 同一秒内多次滚动也要各自留一份
            target = self.path.with_name(f"{self.path.name}.{stamp}.{suffix}")
            suffix += 1
        self.path.replace(target)
        self._prune()

    def _prune(self) -> None:
        cutoff = time.time() - self.retention_days * 86400
        for candidate in self.path.parent.glob(self.path.name + ".*"):
            if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                candidate.unlink(missing_ok=True)


def setup_logging(
    *,
    log_file: Path,
    level: str,
    max_bytes: int,
    retention_days: int,
) -> logging.Logger:
    """给 deskpet 这棵 logger 装上唯一的文件 handler；重复调用幂等（换配置也安全）。

    - 不接管 uvicorn / 第三方库的 logger：它们继续走 stderr，互不干扰；
    - propagate=False：避免同一行被 root handler 再写一遍。
    """
    logger = logging.getLogger(ROOT_LOGGER_NAME)
    logger.setLevel(resolve_level(level))
    logger.propagate = False
    for handler in list(logger.handlers):
        if isinstance(handler, RollingJsonLogHandler):
            logger.removeHandler(handler)
            handler.close()
    handler = RollingJsonLogHandler(
        log_file,
        max_bytes=max_bytes,
        retention_days=retention_days,
    )
    handler.setFormatter(JsonLineFormatter())
    logger.addHandler(handler)
    return logger
