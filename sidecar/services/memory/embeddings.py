"""文件职责：语义索引：查询向量、补建索引、索引状态、失败降级。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

import logging

from core.logging import log_event

from .base import LOGGER, MemoryServiceBase


class EmbeddingMixin(MemoryServiceBase):
    """语义索引：查询向量、补建索引、索引状态、失败降级。"""

    @property
    def embedding(self) -> object | None:
        return self._embedding

    async def embed_query(self, query: str) -> list[float] | None:
        """给对话/搜索链路取查询向量；未配置或失败返回 None（回退 FTS）。"""
        embed = getattr(self._embedding, "embed_query", None)
        if not callable(embed) or not query.strip():
            return None
        try:
            vector = await embed(query)
        except Exception as exc:  # 语义检索是增强项，失败不打断聊天/搜索
            self._degrade_embedding(exc)
            return None
        return vector if isinstance(vector, list) and vector else None

    async def embedding_status(self, *, char_id: str = "") -> dict[str, object]:
        status = getattr(self._embedding, "status", None)
        if not callable(status):
            return {"enabled": False, "available": False, "model": "", "error": ""}
        try:
            result = await status(char_id=char_id)
            return result if isinstance(result, dict) else {}
        except Exception as exc:
            return {
                "enabled": True,
                "available": False,
                "model": self._tuning.model,
                "error": str(exc),
            }

    async def index_embeddings(self, *, char_id: str = "", limit: int = 200) -> dict[str, object]:
        index = getattr(self._embedding, "index_pending", None)
        if not callable(index):
            return {"indexed": 0, "pending": 0, "error": "语义检索未启用"}
        try:
            result = await index(char_id=char_id, limit=limit)
            return result if isinstance(result, dict) else {}
        except Exception as exc:
            return {"indexed": 0, "pending": 0, "error": str(exc)}

    def _degrade_embedding(self, exc: Exception) -> None:
        log_event(
            LOGGER,
            logging.WARNING,
            module="services.memory_service",
            event="memory.embedding_degraded",
            message="语义检索失败，回退全文检索",
            fields={"error": str(exc)},
        )
