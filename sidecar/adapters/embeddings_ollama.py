"""文件职责：本地 Ollama embedding 客户端（T2.31，语义检索适配器）。

为什么只用 Ollama 原生 HTTP：不引入新 SDK；embedding 只在本机回环上调用，记忆原文不离开本机。
依赖方向：adapters -> httpx / core；不 import services / api。
谁调用：services.embedding_service；测试用 httpx.MockTransport 注入。
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence

import httpx

from core.logging import get_logger, log_event

LOGGER = get_logger("sidecar.adapters.embeddings_ollama")

#: 单次请求的兜底超时（连接 + 读取）；由 config 的 timeout_s 覆盖。
DEFAULT_TIMEOUT_S = 20.0


class EmbeddingError(RuntimeError):
    """Ollama 不可达 / 返回坏数据；调用方负责回退 FTS。"""


def _native_base(base_url: str) -> str:
    """把 `http://host:11434/v1` 归一成 Ollama 原生 API 根地址。"""
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return base or "http://127.0.0.1:11434"


def _validated_vector(value: object, expected_dim: int | None = None) -> list[float]:
    if not isinstance(value, list) or not value:
        raise EmbeddingError("Ollama 返回的 embedding 为空或不是数组")
    vector: list[float] = []
    for item in value:
        if not isinstance(item, int | float) or isinstance(item, bool):
            raise EmbeddingError("Ollama embedding 含非数字元素")
        number = float(item)
        if not math.isfinite(number):
            raise EmbeddingError("Ollama embedding 含非有限数")
        vector.append(number)
    if expected_dim is not None and len(vector) != expected_dim:
        raise EmbeddingError(f"embedding 维度不一致：期望 {expected_dim}，收到 {len(vector)}")
    return vector


class OllamaEmbeddingClient:
    """Ollama `/api/embed` 的最小异步客户端。"""

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = _native_base(base_url)
        self._model = model.strip()
        self._timeout_s = timeout_s
        self._transport = transport

    @property
    def model(self) -> str:
        return self._model

    @property
    def base_url(self) -> str:
        return self._base_url

    async def embed(
        self, texts: Sequence[str], *, timeout_s: float | None = None
    ) -> list[list[float]]:
        """把一组文本转成向量；返回顺序与输入一致。"""
        if not self._model:
            raise EmbeddingError("未配置 embedding 模型")
        if not texts:
            return []
        try:
            async with httpx.AsyncClient(
                timeout=timeout_s or self._timeout_s,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    self._base_url + "/api/embed",
                    json={"model": self._model, "input": list(texts)},
                )
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"连接 Ollama 失败：{exc}") from exc
        if response.status_code >= 400:
            raise EmbeddingError(f"Ollama 返回 HTTP {response.status_code}：{response.text[:200]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise EmbeddingError("Ollama 返回的不是 JSON") from exc
        if not isinstance(payload, dict):
            raise EmbeddingError("Ollama 返回结构不正确")
        raw = payload.get("embeddings")
        if not isinstance(raw, list) or len(raw) != len(texts):
            raise EmbeddingError("Ollama embeddings 数量与输入不一致")
        vectors = [_validated_vector(item) for item in raw]
        return vectors

    async def status(self, *, timeout_s: float | None = None) -> tuple[bool, str]:
        """探活：Ollama 可达且模型出现在 /api/tags 里。"""
        try:
            async with httpx.AsyncClient(
                timeout=timeout_s or self._timeout_s,
                transport=self._transport,
            ) as client:
                response = await client.get(self._base_url + "/api/tags")
        except httpx.HTTPError as exc:
            return False, f"Ollama 不可达：{exc}"
        if response.status_code >= 400:
            return False, f"Ollama 返回 HTTP {response.status_code}"
        try:
            payload = response.json()
        except ValueError:
            return False, "Ollama 返回的不是 JSON"
        models = payload.get("models") if isinstance(payload, dict) else None
        names: list[str] = []
        if isinstance(models, list):
            for item in models:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    names.append(item["name"])
        model = self._model
        matched = any(name == model or name.split(":", 1)[0] == model for name in names)
        if not matched:
            log_event(
                LOGGER,
                level=logging.WARNING,
                module="adapters.embeddings_ollama",
                event="embedding.model_missing",
                message="Ollama 没有找到配置的 embedding 模型",
                fields={"model": model, "models": names},
            )
            return False, f"Ollama 未安装模型 {model}（先 ollama pull {model}）"
        return True, ""
