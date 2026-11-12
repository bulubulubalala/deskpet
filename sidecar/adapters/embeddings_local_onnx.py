"""文件职责：进程内 ONNX 向量模型客户端（内置 embedding，T2.40）。

为什么进程内、不走 HTTP：内置模型要「zip 解压即用」——运行时不下载、不联网、不往 userData
复制权重，也就没有端口、没有服务没起来的中间态。模型文件随发布包放在根目录
models/embedding/（源码态是 assets/models/embedding/），进程直接 mmap 读。

为什么惰性 import：onnxruntime / tokenizers 体积大、启动慢，且缺依赖时应只让「语义检索不可用」
而不是让整个 sidecar 起不来（记忆与对话优先）。所以 numpy/onnxruntime/tokenizers 都在 _load()
里 import，失败一律转 EmbeddingError，由 services.embedding_service 回退 FTS。

为什么池化用 [CLS]：bge-* 系列训练时就以首 token 为句向量；mean pooling 在这类模型上相似度
分布会明显走形（本仓库 docs 里记录过 0.50 vs 0.30 的对比）。池化后必须 L2 归一化，
否则内积/余弦排序会被长文本的范数带偏。

为什么一次只推理一条（不攒 batch）：int8 动态量化的 MatMul 按整批激活算 scale/zero_point，
同一句话放进不同批次会得到不同向量（实测单条与 16 条批次的余弦只有 0.989，而批内两条
同长文本是 1.0）。查询走单条、索引如果走批次，就会出现「同一句话查不回自己」的隐性偏差；
而且在这个模型上批处理并不省时间（实测 512 补长时 16 条 306ms vs 单条 19ms，逐条没有更慢）。
所以宁可逐条推理，保证「同一文本 → 同一向量」这条不变量。

依赖方向：adapters -> numpy / onnxruntime / tokenizers；不 import services / api。
谁调用：services.embedding_service（provider="onnx" 时）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from adapters.embeddings_ollama import EmbeddingError
from core.logging import get_logger, log_event

LOGGER = get_logger("sidecar.adapters.embeddings_local_onnx")

#: 内置权重的文件名（见 scripts/fetch_embedding_model.mjs 与 electron-builder.yml）
MODEL_FILE = "model_quantized.onnx"
TOKENIZER_FILE = "tokenizer.json"
#: bge-small-zh 的训练上限；超过就截断，不足补 [PAD]
DEFAULT_MAX_LENGTH = 512


class LocalOnnxEmbeddingClient:
    """本地 ONNX 向量客户端：model_dir 下的 tokenizer.json + model_quantized.onnx。"""

    def __init__(
        self,
        model_dir: Path | None,
        model: str,
        *,
        max_length: int = DEFAULT_MAX_LENGTH,
    ) -> None:
        self._model_dir = Path(model_dir) if model_dir is not None else None
        self._model = model.strip()
        self._max_length = max(8, max_length)
        self._session: Any = None
        self._tokenizer: Any = None
        self._input_names: list[str] = []
        self._dim = 0

    @property
    def model(self) -> str:
        return self._model

    @property
    def model_dir(self) -> Path | None:
        return self._model_dir

    @property
    def dim(self) -> int:
        return self._dim

    def _require_dir(self) -> Path:
        if self._model_dir is None:
            raise EmbeddingError("未配置内置向量模型目录（DESKPET_EMBED_MODEL_DIR）")
        return self._model_dir

    def _load(self) -> None:
        """第一次调用时加载；失败抛 EmbeddingError 并保留现场供下次重试。"""
        if self._session is not None and self._tokenizer is not None:
            return
        directory = self._require_dir()
        model_path = directory / MODEL_FILE
        tokenizer_path = directory / TOKENIZER_FILE
        missing = [p for p in (model_path, tokenizer_path) if not p.is_file()]
        if missing:
            raise EmbeddingError("内置向量模型文件缺失：" + "、".join(str(p) for p in missing))
        try:
            import onnxruntime  # type: ignore[import-untyped]
            from tokenizers import Tokenizer
        except ImportError as exc:  # pragma: no cover - 依赖缺失只在裁剪安装包时出现
            raise EmbeddingError(f"缺少内置向量依赖：{exc}") from exc
        started = time.perf_counter()
        try:
            session = onnxruntime.InferenceSession(
                str(model_path), providers=["CPUExecutionProvider"]
            )
            tokenizer = Tokenizer.from_file(str(tokenizer_path))
            tokenizer.enable_truncation(max_length=self._max_length)
            # 必须补 padding：一批文本长度不齐时 encode_batch 拼不出矩形数组
            tokenizer.enable_padding()
        except Exception as exc:
            raise EmbeddingError(f"内置向量模型加载失败：{exc}") from exc
        self._session = session
        self._tokenizer = tokenizer
        self._input_names = [item.name for item in session.get_inputs()]
        outputs = session.get_outputs()
        if not outputs:
            raise EmbeddingError("内置向量模型没有输出节点")
        shape = outputs[0].shape
        self._dim = int(shape[-1]) if shape and isinstance(shape[-1], int) else 0
        log_event(
            LOGGER,
            logging.INFO,
            module="adapters.embeddings_local_onnx",
            event="embedding.loaded",
            message="内置向量模型已加载",
            fields={
                "model": self._model,
                "dir": str(directory),
                "dim": self._dim,
                "ms": round((time.perf_counter() - started) * 1000, 1),
            },
        )

    def _encode_one(self, np: Any, text: str) -> Any:
        """单条推理：返回 L2 归一化后的 [CLS] 向量（1-D float32）。"""
        encoded = self._tokenizer.encode(text)
        feeds: dict[str, Any] = {
            "input_ids": np.array([encoded.ids], dtype=np.int64),
            "attention_mask": np.array([encoded.attention_mask], dtype=np.int64),
        }
        if "token_type_ids" in self._input_names:
            feeds["token_type_ids"] = np.zeros_like(feeds["input_ids"])
        for name in self._input_names:
            if name not in feeds:
                raise EmbeddingError(f"内置向量模型要求未知输入：{name}")
        inputs = {name: feeds[name] for name in self._input_names}
        try:
            outputs = self._session.run(None, inputs)
        except Exception as exc:
            raise EmbeddingError(f"内置向量推理失败：{exc}") from exc
        hidden = outputs[0]
        if getattr(hidden, "ndim", 0) != 3:
            raise EmbeddingError("内置向量模型输出形状不是 [batch, seq, dim]")
        # [CLS] 池化 + L2 归一化（见文件头「为什么池化用 [CLS]」）
        vector = hidden[0, 0, :].astype(np.float32, copy=False)
        norm = float(np.linalg.norm(vector))
        return vector if norm == 0.0 else vector / norm

    def _encode_sync(self, texts: Sequence[str]) -> list[list[float]]:
        import numpy as np

        self._load()
        # 逐条推理：见文件头「为什么一次只推理一条」
        return [self._encode_one(np, text).tolist() for text in texts]

    async def embed(
        self, texts: Sequence[str], *, timeout_s: float | None = None
    ) -> list[list[float]]:
        """把一组文本转成向量；返回顺序与输入一致。"""
        if not texts:
            return []
        if not self._model:
            raise EmbeddingError("未配置 embedding 模型")
        try:
            return await asyncio.to_thread(self._encode_sync, list(texts))
        except EmbeddingError:
            raise
        except Exception as exc:
            raise EmbeddingError(f"内置向量化失败：{exc}") from exc

    async def status(self, *, timeout_s: float | None = None) -> tuple[bool, str]:
        """探活：文件齐 + 能加载；不跑推理（省内存、也更快）。"""
        directory = self._model_dir
        if directory is None:
            return False, "未配置内置向量模型目录（DESKPET_EMBED_MODEL_DIR）"
        required = (directory / MODEL_FILE, directory / TOKENIZER_FILE)
        missing = [p for p in required if not p.is_file()]
        if missing:
            return False, "内置向量模型文件缺失：" + "、".join(str(p) for p in missing)
        try:
            await asyncio.to_thread(self._load)
        except EmbeddingError as exc:
            return False, str(exc)
        except Exception as exc:
            return False, f"内置向量模型加载失败：{exc}"
        return True, ""
