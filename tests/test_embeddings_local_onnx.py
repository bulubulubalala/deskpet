"""文件职责：内置 ONNX 向量适配器的单测（T2.40）。

两层：模型文件缺失/依赖缺失时的降级行为（任何机器都能跑），以及真模型 smoke
（assets/models/embedding 下有权重时才跑；权重不进 git，靠 scripts/fetch_embedding_model.mjs 拉）。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from adapters.embeddings_local_onnx import (
    MODEL_FILE,
    TOKENIZER_FILE,
    LocalOnnxEmbeddingClient,
)
from adapters.embeddings_ollama import EmbeddingError

REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_DIR = REPO_ROOT / "assets" / "models" / "embedding"
HAS_FILES = (BUNDLED_DIR / MODEL_FILE).is_file() and (BUNDLED_DIR / TOKENIZER_FILE).is_file()
HAS_DEPS = (
    importlib.util.find_spec("onnxruntime") is not None
    and importlib.util.find_spec("tokenizers") is not None
    and importlib.util.find_spec("numpy") is not None
)
needs_model = pytest.mark.skipif(
    not (HAS_FILES and HAS_DEPS),
    reason="内置模型权重或 onnxruntime/tokenizers 不在本机（跑 scripts/fetch_embedding_model.mjs）",
)


def _cos(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


async def test_status_reports_missing_model_dir() -> None:
    ready, error = await LocalOnnxEmbeddingClient(None, "m").status()
    assert ready is False
    assert "DESKPET_EMBED_MODEL_DIR" in error


async def test_status_reports_missing_files(tmp_path: Path) -> None:
    ready, error = await LocalOnnxEmbeddingClient(tmp_path, "m").status()
    assert ready is False
    # 报错必须带完整路径：用户才知道该把模型放到哪
    assert MODEL_FILE in error and str(tmp_path) in error


async def test_embed_without_files_raises_embedding_error(tmp_path: Path) -> None:
    client = LocalOnnxEmbeddingClient(tmp_path, "m")
    with pytest.raises(EmbeddingError, match="缺失"):
        await client.embed(["你好"])


async def test_empty_input_returns_empty_without_loading(tmp_path: Path) -> None:
    client = LocalOnnxEmbeddingClient(tmp_path, "m")
    assert await client.embed([]) == []


@needs_model
async def test_vectors_are_unit_length_and_dim_from_model() -> None:
    client = LocalOnnxEmbeddingClient(BUNDLED_DIR, "bge-small-zh-v1.5:int8@1")
    vectors = await client.embed(["我养了一只猫", "我养了一只猫"])
    assert len(vectors) == 2
    assert len(vectors[0]) == 512
    assert client.dim == 512
    for vector in vectors:
        assert abs(sum(value * value for value in vector) - 1.0) < 1e-4
    # 同一句话两次编码必须一致（池化/归一化没引入随机性）
    assert vectors[0] == vectors[1]


@needs_model
async def test_similarity_prefers_related_text() -> None:
    client = LocalOnnxEmbeddingClient(BUNDLED_DIR, "bge-small-zh-v1.5:int8@1")
    cat, animal, weather = await client.embed(["我养了一只猫", "家里有小动物", "今天天气很好"])
    assert _cos(cat, animal) > _cos(cat, weather) + 0.1


@needs_model
async def test_batching_never_changes_a_vector() -> None:
    # int8 动态量化按整批激活算 scale：曾经把「猫」和一句长文本一起编码，余弦掉到 0.989。
    # 适配器改成逐条推理后，批次构成不能影响任何一条的向量（这是检索自洽的底线）。
    client = LocalOnnxEmbeddingClient(BUNDLED_DIR, "bge-small-zh-v1.5:int8@1")
    short = await client.embed(["猫"])
    batched = await client.embed(["猫", "今天天气很好，出门散步心情不错", "我家有只小狗"])
    assert batched[0] == short[0]
    assert _cos(batched[0], short[0]) > 0.999999
