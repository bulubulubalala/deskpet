"""文件职责：Ollama embedding 适配器的离线单测（T2.31）。

用 httpx.MockTransport，不联网；覆盖成功、HTTP 错误、模型缺失探活。
"""

import httpx
import pytest

from adapters.embeddings_ollama import EmbeddingError, OllamaEmbeddingClient


def _client(handler) -> OllamaEmbeddingClient:
    return OllamaEmbeddingClient(
        "http://127.0.0.1:11434/v1",
        "bge-m3",
        timeout_s=1.0,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_embed_posts_to_native_api_and_returns_vectors() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content.decode("utf-8")
        return httpx.Response(200, json={"embeddings": [[1, 2], [3, 4]]})

    vectors = await _client(handler).embed(["a", "b"])
    assert vectors == [[1.0, 2.0], [3.0, 4.0]]
    assert seen["url"] == "http://127.0.0.1:11434/api/embed"
    assert "bge-m3" in str(seen["body"])


@pytest.mark.asyncio
async def test_embed_rejects_bad_shape_and_http_error() -> None:
    def bad_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[1.0]]})

    with pytest.raises(EmbeddingError):
        await _client(bad_handler).embed(["a", "b"])

    def error_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with pytest.raises(EmbeddingError):
        await _client(error_handler).embed(["a"])


@pytest.mark.asyncio
async def test_status_checks_model_in_tags() -> None:
    def missing_model(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "nomic-embed-text:latest"}]})

    ready, error = await _client(missing_model).status()
    assert ready is False
    assert "bge-m3" in error

    def has_model(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "bge-m3:latest"}]})

    ready, error = await _client(has_model).status()
    assert ready is True
    assert error == ""
