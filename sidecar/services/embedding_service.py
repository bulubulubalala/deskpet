"""文件职责：语义检索的索引与查询服务（T2.31）。

为什么单独一层：Ollama 可能没装、没拉模型、临时不可用；记忆/对话绝不能因此失败。
本层负责「把未索引的消息/事实排进向量表」和「把查询文本变成向量」，所有失败只记日志并回退 FTS。
依赖方向：services -> adapters（Ollama client）/ core；不 import api。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from typing import Protocol

from adapters.embeddings_ollama import OllamaEmbeddingClient
from config import EmbeddingSettings, Settings
from core.logging import get_logger, log_event
from core.memory import EmbeddingSource, MemoryStore

LOGGER = get_logger("services.embedding_service")

#: 查询失败后 30s 内直接走 FTS，避免每一轮对话都去等 Ollama 超时
QUERY_FAILURE_COOLDOWN_S = 30.0


class EmbeddingClient(Protocol):
    """消费侧需要的向量客户端能力：Ollama 与内置 ONNX 实现同一组方法。"""

    async def embed(
        self, texts: Sequence[str], *, timeout_s: float | None = None
    ) -> list[list[float]]: ...

    async def status(self, *, timeout_s: float | None = None) -> tuple[bool, str]: ...


def _build_client(settings: EmbeddingSettings) -> EmbeddingClient:
    """按 provider 造客户端；内置实现惰性 import，缺依赖时不影响 Ollama 路径。"""
    if settings.provider == "onnx":
        from adapters.embeddings_local_onnx import LocalOnnxEmbeddingClient

        return LocalOnnxEmbeddingClient(settings.model_dir, settings.model)
    return OllamaEmbeddingClient(
        settings.base_url,
        settings.model,
        timeout_s=settings.timeout_s,
    )


class EmbeddingService:
    def __init__(
        self,
        store: MemoryStore | None,
        settings: EmbeddingSettings,
        *,
        client_factory: Callable[[], EmbeddingClient] | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._client_factory = client_factory or (lambda: _build_client(settings))
        self._client: EmbeddingClient | None = None
        self._now = now or time.time
        self._query_blocked_until = 0.0
        self._running = False

    @property
    def available(self) -> bool:
        # 内置模型没有 model 字符串也能跑，但没有目录就无米下锅
        if self._settings.provider == "onnx" and self._settings.model_dir is None:
            return False
        return bool(self._settings.enabled and self._store is not None and self._settings.model)

    @property
    def model(self) -> str:
        return self._settings.model

    def _get_client(self) -> EmbeddingClient:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    async def embed_query(self, query: str) -> list[float] | None:
        """查询文本 → 向量；未启用 / 失败返回 None。"""
        if not self.available or not query.strip():
            return None
        if self._now() < self._query_blocked_until:
            return None
        try:
            vectors = await self._get_client().embed(
                [query], timeout_s=self._settings.query_timeout_s
            )
        except Exception as exc:
            self._query_blocked_until = self._now() + QUERY_FAILURE_COOLDOWN_S
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.embedding_service",
                event="embedding.query_failed",
                message="查询向量化失败，回退全文检索",
                fields={"error": str(exc)},
            )
            return None
        self._query_blocked_until = 0.0
        return vectors[0] if vectors else None

    async def index_pending(self, *, char_id: str = "", limit: int = 200) -> dict[str, object]:
        """把未索引的消息/事实分批写入向量表，返回本次索引数与剩余数。"""
        if not self.available:
            return {"indexed": 0, "pending": 0, "error": "语义检索未启用"}
        store = self._store
        if store is None:
            return {"indexed": 0, "pending": 0, "error": "记忆库不可用"}
        try:
            sources = store.pending_embeddings(
                model_id=self._settings.model,
                char_id=char_id,
                limit=max(1, limit),
            )
        except Exception as exc:
            return {"indexed": 0, "pending": 0, "error": str(exc)}
        if not sources:
            indexed, pending = store.embedding_counts(
                model_id=self._settings.model, char_id=char_id
            )
            return {"indexed": indexed, "pending": pending, "error": ""}
        indexed_count = 0
        error = ""
        batch_size = max(1, self._settings.batch_size)
        try:
            for start in range(0, len(sources), batch_size):
                batch: list[EmbeddingSource] = sources[start : start + batch_size]
                vectors = await self._get_client().embed([item.text for item in batch])
                if len(vectors) != len(batch):
                    raise ValueError("embedding 数量与待索引条目不一致")
                now = self._now()
                for source, vector in zip(batch, vectors, strict=False):
                    store.upsert_embedding(
                        source,
                        vector,
                        model_id=self._settings.model,
                        now=now,
                    )
                    indexed_count += 1
        except Exception as exc:
            error = str(exc)
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.embedding_service",
                event="embedding.index_failed",
                message="语义索引失败，稍后重试",
                fields={"error": error, "indexed": indexed_count},
            )
        try:
            indexed, pending = store.embedding_counts(
                model_id=self._settings.model, char_id=char_id
            )
        except Exception:
            indexed, pending = indexed_count, 0
        return {"indexed": indexed, "pending": pending, "error": error}

    @property
    def _status_labels(self) -> dict[str, object]:
        """状态快照里与后端有关的字段；onnx 没有 base_url，别把 Ollama 地址塞给界面。"""
        return {
            "model": self._settings.model,
            "provider": self._settings.provider,
            "model_dir": str(self._settings.model_dir) if self._settings.model_dir else "",
            "base_url": "" if self._settings.provider == "onnx" else self._settings.base_url,
        }

    async def status(self, *, char_id: str = "") -> dict[str, object]:
        """给设置/记忆中心的状态快照。"""
        if not self._settings.enabled:
            return {
                **self._status_labels,
                "enabled": False,
                "available": False,
                "indexed": 0,
                "pending": 0,
                "error": "",
            }
        if self._store is None:
            return {
                **self._status_labels,
                "enabled": True,
                "available": False,
                "indexed": 0,
                "pending": 0,
                "error": "记忆库不可用",
            }
        ready, error = await self._get_client().status(timeout_s=self._settings.query_timeout_s)
        try:
            indexed, pending = self._store.embedding_counts(
                model_id=self._settings.model, char_id=char_id
            )
        except Exception as exc:
            indexed, pending = 0, 0
            error = error or str(exc)
        return {
            **self._status_labels,
            "enabled": True,
            "available": ready,
            "indexed": indexed,
            "pending": pending,
            "error": error,
        }

    async def run_forever(self) -> None:
        """后台索引循环；没启用时安静休眠，不占 CPU。"""
        if self._running:
            return
        self._running = True
        try:
            while True:
                if self.available:
                    try:
                        await self.index_pending(limit=max(self._settings.batch_size * 8, 64))
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        # index_pending 自己已经兜住；这里只防意外
                        pass
                await asyncio.sleep(max(5.0, self._settings.interval_s))
        finally:
            self._running = False


def build_embedding_service(
    settings: Settings,
    store: MemoryStore | None,
) -> EmbeddingService:
    """组合根用：从 Settings 取 embedding 配置。"""
    embedding_settings = getattr(settings, "embedding", EmbeddingSettings())
    return EmbeddingService(store, embedding_settings)
