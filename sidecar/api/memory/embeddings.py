"""文件职责：语义索引：看一眼索引状态、手动补建。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：api/memory/service.py 装配路由时调用 register_embedding_routes()。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from contracts.api_models import (
    MemoryEmbeddingIndexRequest,
    MemoryEmbeddingIndexResponse,
    MemoryEmbeddingStatus,
    MemoryEmbeddingStatusQuery,
)
from services.memory_service import MemoryService

from .shared import _ERROR_RESPONSES


def register_embedding_routes(router: APIRouter, service: MemoryService) -> None:
    """语义索引：看一眼索引状态、手动补建。"""

    @router.get(
        "/memory/embeddings/status",
        summary="语义检索状态（内置 ONNX 或 Ollama embedding）",
        response_model=MemoryEmbeddingStatus,
        responses=_ERROR_RESPONSES,
    )
    async def embedding_status(
        query: Annotated[MemoryEmbeddingStatusQuery, Query()],
    ) -> MemoryEmbeddingStatus:
        payload = await service.embedding_status(char_id=query.char_id)
        indexed = payload.get("indexed", 0)
        pending = payload.get("pending", 0)
        return MemoryEmbeddingStatus(
            enabled=bool(payload.get("enabled", False)),
            available=bool(payload.get("available", False)),
            model=str(payload.get("model", "")),
            provider=str(payload.get("provider", "")),
            base_url=str(payload.get("base_url", "")),
            model_dir=str(payload.get("model_dir", "")),
            indexed=int(indexed) if isinstance(indexed, int | float | str) else 0,
            pending=int(pending) if isinstance(pending, int | float | str) else 0,
            error=str(payload.get("error", "")),
        )

    @router.post(
        "/memory/embeddings/index",
        summary="手动补索引消息/事实的向量",
        response_model=MemoryEmbeddingIndexResponse,
        responses=_ERROR_RESPONSES,
    )
    async def embedding_index(
        payload: MemoryEmbeddingIndexRequest,
    ) -> MemoryEmbeddingIndexResponse:
        result = await service.index_embeddings(char_id=payload.char_id, limit=payload.limit)
        indexed = result.get("indexed", 0)
        pending = result.get("pending", 0)
        return MemoryEmbeddingIndexResponse(
            indexed=int(indexed) if isinstance(indexed, int | float | str) else 0,
            pending=int(pending) if isinstance(pending, int | float | str) else 0,
            error=str(result.get("error", "")),
        )
