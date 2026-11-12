"""错误详情（D6 排查）：脱敏、截断、端点清洗与异常归一化。"""

from __future__ import annotations

from contracts.errors import CODE_LLM_BAD_RESPONSE
from core.error_detail import (
    build_error_detail,
    detail_from_exception,
    manual_error_detail,
)
from core.errors import LlmError
from core.redact import (
    MAX_ERROR_BODY_CHARS,
    clip_text,
    redact_secrets,
    safe_endpoint,
)


def test_redact_secrets_covers_common_key_shapes() -> None:
    text = (
        'Authorization: Bearer abcdef123456\n'
        '{"api_key": "sk-probe-123456", "token": "tok_987654"}\n'
        "https://api.example.com/v1?token=query-secret&key=another-secret"
    )
    masked = redact_secrets(text)

    assert "sk-probe-123456" not in masked
    assert "abcdef123456" not in masked
    assert "tok_987654" not in masked
    assert "query-secret" not in masked
    assert "another-secret" not in masked
    assert "api_key" in masked  # 字段名保留，方便看出「这里本来有值」


def test_safe_endpoint_strips_query_userinfo_and_fragment() -> None:
    assert (
        safe_endpoint("https://user:pass@api.example.com:8443/v1/chat?token=secret#frag")
        == "https://api.example.com:8443/v1/chat"
    )
    assert safe_endpoint("not a url?token=x") == "not a url"
    assert safe_endpoint("") == ""


def test_clip_text_never_exceeds_limit() -> None:
    assert clip_text("abc", 3) == "abc"
    assert clip_text("abcd", 3) == "ab…"
    assert clip_text("abcd", 1) == "…"
    assert clip_text("abcd", 0) == ""


def test_build_error_detail_normalizes_context_and_redacts() -> None:
    error = LlmError(
        CODE_LLM_BAD_RESPONSE,
        "模型服务返回 HTTP 500：sk-probe-123456",
        user_hint="模型出错了",
        context={
            "status": 500,
            "body": '{"error":"bad key sk-probe-123456"}',
            "url": "https://user:pass@api.example.com/v1/chat?token=secret",
            "model": "demo-model",
            "request_id": "req-123",
        },
    )

    detail = build_error_detail(error, attempts=3)

    assert detail.status == 500
    assert detail.model == "demo-model"
    assert detail.request_id == "req-123"
    assert detail.attempts == 3
    assert detail.endpoint == "https://api.example.com/v1/chat"
    assert "sk-probe-123456" not in detail.message
    assert "sk-probe-123456" not in detail.body
    assert len(detail.body) <= MAX_ERROR_BODY_CHARS


def test_build_error_detail_uses_error_object_as_body_fallback() -> None:
    error = LlmError(
        CODE_LLM_BAD_RESPONSE,
        "流里返回错误",
        context={"error": {"message": "rate limited", "code": "429"}},
    )

    detail = build_error_detail(error)

    assert "rate limited" in detail.body
    assert detail.status is None


def test_manual_and_unexpected_details_stay_useful() -> None:
    manual = manual_error_detail("没有配置端点", endpoint="http://127.0.0.1:9/v1?token=x")
    assert manual.endpoint == "http://127.0.0.1:9/v1"
    assert manual.message == "没有配置端点"

    runtime = detail_from_exception(RuntimeError("boom sk-probe-123456"))
    assert "RuntimeError: boom" in runtime.message
    assert "sk-probe-123456" not in runtime.message
