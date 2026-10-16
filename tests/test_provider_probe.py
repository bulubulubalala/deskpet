"""文件职责：单测 adapters/provider_probe.py 的出网路径（需求 §6.13 / T1.14b）。

为什么用 MockTransport：成功 / HTTP 错误 / 超时 / 连不上 / 坏格式这五种形态在真端点上无法
按需复现，而它们恰好是「测试连接」按钮要展示的全部文案来源（§6.7 的明确报错态度）。

依赖方向：tests -> adapters + httpx.MockTransport；不联网、不需要任何引擎。
"""

from __future__ import annotations

from pathlib import Path

import httpx

from adapters.provider_probe import probe_asr_local, probe_llm_endpoint, probe_tts_adapter

LLM_URL = "https://api.example.com/v1"
SECRET = "sk-secret-value"


def _ok_llm_body() -> dict[str, object]:
    return {"choices": [{"message": {"role": "assistant", "content": "pong"}}]}


async def test_llm_probe_reports_success_and_sends_bearer_key() -> None:
    """成功路径：带 key、打到 /chat/completions、结论 ok 且耗时非负。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_ok_llm_body())

    outcome = await probe_llm_endpoint(
        LLM_URL, SECRET, "test-model", transport=httpx.MockTransport(handler)
    )

    assert outcome.ok is True
    assert outcome.elapsed_ms >= 0
    assert len(seen) == 1
    assert str(seen[0].url) == LLM_URL + "/chat/completions"
    assert seen[0].headers["Authorization"] == "Bearer " + SECRET


async def test_llm_probe_without_key_sends_no_authorization() -> None:
    """没配 key 就不发 Authorization 头：本地 Ollama 之类不接受空 Bearer。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_ok_llm_body())

    outcome = await probe_llm_endpoint(
        "http://127.0.0.1:11434/v1", "", "test-model", transport=httpx.MockTransport(handler)
    )

    assert outcome.ok is True
    assert "Authorization" not in seen[0].headers


async def test_llm_probe_reports_http_error_without_leaking_key() -> None:
    """401 要给出状态码与响应体预览，但结论里绝不能出现密钥。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text='{"error":"invalid api key"}')

    outcome = await probe_llm_endpoint(
        LLM_URL, SECRET, "test-model", transport=httpx.MockTransport(handler)
    )

    assert outcome.ok is False
    assert "HTTP 401" in outcome.detail
    assert "invalid api key" in outcome.detail
    assert SECRET not in outcome.detail


async def test_llm_probe_reports_timeout_and_connect_error() -> None:
    """超时与连不上是两类最常见的红字，文案必须能区分。"""

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    timed_out = await probe_llm_endpoint(LLM_URL, "", "m", transport=httpx.MockTransport(slow))
    unreachable = await probe_llm_endpoint(LLM_URL, "", "m", transport=httpx.MockTransport(refused))

    assert timed_out.ok is False
    assert "超时" in timed_out.detail
    assert unreachable.ok is False
    assert "连不上" in unreachable.detail


async def test_llm_probe_rejects_non_json_and_missing_choices() -> None:
    """200 也可能是坏响应（HTML 门户页、缺 choices 的代理），要如实报错。"""

    def html(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>login</html>")

    def wrong_shape(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"result": "pong"})

    non_json = await probe_llm_endpoint(LLM_URL, "", "m", transport=httpx.MockTransport(html))
    wrong = await probe_llm_endpoint(LLM_URL, "", "m", transport=httpx.MockTransport(wrong_shape))

    assert non_json.ok is False
    assert "不是 JSON" in non_json.detail
    assert wrong.ok is False
    assert "不是 OpenAI 兼容格式" in wrong.detail


async def test_tts_probe_hits_health_with_token_and_reads_ready_flag() -> None:
    """TTS 探测只打 GET /health（不触发加载模型），并按 ready 字段改口吻。"""
    seen: list[httpx.Request] = []
    ready_flag = {"value": False}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "ok", "ready": ready_flag["value"]})

    not_loaded = await probe_tts_adapter(
        "http://127.0.0.1:8742", "tok", transport=httpx.MockTransport(handler)
    )
    ready_flag["value"] = True
    loaded = await probe_tts_adapter(
        "http://127.0.0.1:8742", "tok", transport=httpx.MockTransport(handler)
    )

    assert seen[0].method == "GET"
    assert seen[0].url.path == "/health"
    assert seen[0].headers["X-Deskpet-Token"] == "tok"
    assert "尚未加载" in not_loaded.detail
    assert "模型已加载" in loaded.detail


async def test_tts_probe_reports_http_failure() -> None:
    """适配器起着但报错（例如 500）时不能给绿点。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="engine busy")

    outcome = await probe_tts_adapter(
        "http://127.0.0.1:8742", "", transport=httpx.MockTransport(handler)
    )

    assert outcome.ok is False
    assert "HTTP 503" in outcome.detail


def test_asr_local_probe_treats_missing_model_as_legal_but_slow(tmp_path: Path) -> None:
    """本地模型没落地不是失败：它是合法配置，只是首次识别会下载。"""
    missing = probe_asr_local("small", tmp_path / "models")
    ready_dir = tmp_path / "model"
    ready_dir.mkdir()

    ready = probe_asr_local(str(ready_dir), tmp_path / "models")

    assert missing.ok is True
    assert "尚未落地" in missing.detail
    assert str(tmp_path / "models") in missing.detail
    assert ready.ok is True
    assert "已就位" in ready.detail
