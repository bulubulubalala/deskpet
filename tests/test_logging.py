"""文件职责：T0.4 日志与错误码骨架的契约测试。

为什么不需要硬件：全部落在 core/adapters 的纯逻辑与本地文件上，不加载模型（CODE_STYLE §7）。
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from adapters.log_writer import JsonLineFormatter, RollingJsonLogHandler, resolve_level, setup_logging
from contracts.errors import (
    CODE_TTS_SYNTHESIS_FAILED,
    ERROR_CODE_PATTERN,
    ERROR_CODES,
    ErrorDomain,
    domain_of,
)
from core.errors import MemoryStoreError, TtsError
from core.logging import REDACTED, SENSITIVE_KEYS, format_trace, get_logger, log_event

LOG_NAME = "deskpet.log"


def _detach_our_handlers(root: logging.Logger) -> None:
    """只摘我们自己装的 handler：pytest 的 caplog 也会往 deskpet logger 上挂东西。"""

    for handler in list(root.handlers):
        if isinstance(handler, RollingJsonLogHandler):
            root.removeHandler(handler)
            handler.close()


@pytest.fixture()
def log_file(tmp_path: Path) -> Path:
    return tmp_path / LOG_NAME


@pytest.fixture()
def root_logger(log_file: Path) -> Iterator[logging.Logger]:
    """给测试装一个真 handler（写磁盘）；用完摘掉，避免污染别的测试。"""

    root = setup_logging(log_file=log_file, level="debug", max_bytes=1024 * 1024, retention_days=7)
    yield root
    _detach_our_handlers(root)


def _records(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_log_line_is_single_line_json_with_intact_chinese(
    root_logger: logging.Logger, log_file: Path
) -> None:
    log_event(
        get_logger("test"),
        logging.INFO,
        module="test",
        event="demo",
        message="嗓子哑了，你快点修一下",
        fields={"port": 8737},
    )
    raw = log_file.read_bytes()
    assert b"\r" not in raw  # 只写 \n：Windows 上不许出现 CRLF
    assert raw.decode("utf-8").count("\n") == 1
    record = _records(log_file)[0]
    assert record["level"] == "INFO"
    assert record["logger"] == "deskpet.test"
    assert record["message"] == "嗓子哑了，你快点修一下"
    assert record["event"] == "demo"
    assert record["port"] == 8737
    assert str(record["ts"]).endswith("+00:00")


def test_sensitive_fields_are_redacted(root_logger: logging.Logger, log_file: Path) -> None:
    log_event(
        get_logger("test"),
        logging.INFO,
        module="test",
        event="demo",
        message="调用云端",
        fields={
            "api_key": "sk-secret-value",
            "ocr_text": "屏幕上的密码是 123456",
            "ref_audio_path": "D:/voice/amber.wav",
            "port": 8737,
        },
    )
    text = log_file.read_text(encoding="utf-8")
    for secret in ("sk-secret-value", "屏幕上的密码是 123456", "D:/voice/amber.wav"):
        assert secret not in text
    record = _records(log_file)[0]
    assert record["api_key"] == REDACTED
    assert record["port"] == 8737  # 非敏感字段照原样留着，方便排查
    assert {"api_key", "ocr_text", "ref_audio_path"} <= set(SENSITIVE_KEYS)


def test_deskpet_error_logs_code_domain_and_trace(
    root_logger: logging.Logger, log_file: Path
) -> None:
    try:
        raise TtsError(
            CODE_TTS_SYNTHESIS_FAILED,
            "单句合成超时",
            user_hint="语音引擎异常，先看文字",
            context={"sentence_index": 2},
        )
    except TtsError as exc:
        log_event(
            get_logger("test"),
            logging.ERROR,
            module="services.tts",
            event="tts_failed",
            message=exc.message,
            code=exc.code,
            domain=str(exc.domain),
            trace=format_trace(exc),
            fields=exc.context,
        )
    record = _records(log_file)[0]
    assert record["code"] == CODE_TTS_SYNTHESIS_FAILED == "DP-TTS-003"
    assert record["domain"] == "TTS"
    assert record["sentence_index"] == 2
    assert "TtsError" in str(record["trace"])
    assert "单句合成超时" in str(record["trace"])


def test_error_envelope_keeps_user_hint_separate() -> None:
    error = TtsError(CODE_TTS_SYNTHESIS_FAILED, "单句合成超时", user_hint="语音引擎异常")
    envelope = error.to_envelope()
    assert envelope.code == CODE_TTS_SYNTHESIS_FAILED
    assert envelope.user_hint == "语音引擎异常"
    assert str(error) == "DP-TTS-003 单句合成超时"


def test_error_rejects_code_from_another_domain() -> None:
    with pytest.raises(ValueError):
        TtsError("DP-LLM-001", "域写错了")


def test_every_error_code_matches_pattern_and_domain() -> None:
    assert len(ERROR_CODES) == len(set(ERROR_CODES))
    for code in ERROR_CODES:
        assert re.fullmatch(ERROR_CODE_PATTERN, code), code
        assert str(domain_of(code)) == code.split("-")[1]


@pytest.mark.parametrize("bad_code", ["DP-XXX-001", "nope", "dp-tts-003", "DP-TTS-01"])
def test_domain_of_rejects_bad_codes(bad_code: str) -> None:
    with pytest.raises(ValueError):
        domain_of(bad_code)


def test_memory_domain_does_not_shadow_builtin_memory_error() -> None:
    """DP-MEM 的异常叫 MemoryStoreError：不覆盖内建 MemoryError（OOM 处理要用它）。"""

    error = MemoryStoreError("DP-MEM-002", "记忆库只读降级")
    assert error.domain is ErrorDomain.MEM
    assert not issubclass(MemoryStoreError, MemoryError)


def test_handler_rotates_before_exceeding_max_bytes(tmp_path: Path) -> None:
    path = tmp_path / LOG_NAME
    handler = RollingJsonLogHandler(path, max_bytes=250, retention_days=7)
    handler.setFormatter(JsonLineFormatter())
    logger = logging.getLogger("deskpet.rotate")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.handlers = [handler]
    try:
        for index in range(20):
            logger.info("第 %d 条日志，用来把文件写满从而触发滚动", index)
    finally:
        logger.handlers = []
        handler.close()
    assert sorted(path.parent.glob(path.name + ".*")), "应当至少滚动出一个历史文件"
    assert path.exists()
    assert path.stat().st_size <= 250


def test_handler_prunes_files_older_than_retention(tmp_path: Path) -> None:
    path = tmp_path / LOG_NAME
    stale = path.with_name(path.name + ".20200101T000000")
    stale.write_text("{}\n", encoding="utf-8")
    old = time.time() - 10 * 86400
    os.utime(stale, (old, old))
    fresh = path.with_name(path.name + ".20990101T000000")
    fresh.write_text("{}\n", encoding="utf-8")
    RollingJsonLogHandler(path, max_bytes=1024, retention_days=7).close()
    assert not stale.exists()
    assert fresh.exists()


def test_setup_logging_replaces_its_own_handler(tmp_path: Path) -> None:
    first = setup_logging(
        log_file=tmp_path / "a.log", level="info", max_bytes=1024, retention_days=7
    )
    second = setup_logging(
        log_file=tmp_path / "b.log", level="debug", max_bytes=1024, retention_days=7
    )
    try:
        assert first is second
        ours = [h for h in second.handlers if isinstance(h, RollingJsonLogHandler)]
        assert len(ours) == 1  # 重复 setup 只留一个我们自己的 handler
        assert ours[0].path == tmp_path / "b.log"
        assert second.level == logging.DEBUG
        assert second.propagate is False
    finally:
        _detach_our_handlers(second)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("debug", logging.DEBUG),
        ("INFO", logging.INFO),
        ("warn", logging.WARNING),
        ("error", logging.ERROR),
        ("胡说", logging.INFO),
    ],
)
def test_resolve_level(raw: str, expected: int) -> None:
    assert resolve_level(raw) == expected


@pytest.mark.parametrize("raw", ["0", "-1", "abc"])
@pytest.mark.parametrize("key", ["DESKPET_LOG_MAX_BYTES", "DESKPET_LOG_RETENTION_DAYS"])
def test_load_settings_rejects_bad_log_numbers(key: str, raw: str) -> None:
    from config import load_settings

    with pytest.raises(ValueError):
        load_settings({key: raw})


def test_load_settings_log_defaults_match_requirement() -> None:
    from config import DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_RETENTION_DAYS, load_settings

    settings = load_settings({})
    assert settings.log_max_bytes == DEFAULT_LOG_MAX_BYTES == 20 * 1024 * 1024
    assert settings.log_retention_days == DEFAULT_LOG_RETENTION_DAYS == 7
    assert settings.log_file.name == "deskpet.log"
    assert settings.log_file.parent.name == "logs"
    assert load_settings({"DESKPET_LOG_MAX_BYTES": "1024"}).log_max_bytes == 1024
