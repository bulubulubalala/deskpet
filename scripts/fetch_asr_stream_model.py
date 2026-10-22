"""文件职责：下载 sherpa-onnx 中文流式模型（P2 流式识别的可选依赖）。

为什么单独一个脚本而不是自动下载：模型 ~70 MB，按 D14/D19 的精神「只调用、不替用户装东西」；
用户显式跑一次、或把已有模型放进 data/models/asr-stream/ 都行。模型缺失时 sidecar 会自动
退回批处理，语音不会因此变哑。

用法：
    .venv\\Scripts\\python.exe scripts/fetch_asr_stream_model.py
    # 国内 / 走代理：
    .venv\\Scripts\\python.exe scripts/fetch_asr_stream_model.py --proxy http://127.0.0.1:10808
    # 也可以直接给镜像 URL：
    ... --url https://hf-mirror.com/.../model.tar.bz2

产物：<仓库>/data/models/asr-stream/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/
"""

from __future__ import annotations

import argparse
import os
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
)
DEFAULT_TARGET = REPO_ROOT / "data" / "models" / "asr-stream"
MODEL_DIR_NAME = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"


def _is_complete(model_dir: Path) -> bool:
    if not (model_dir / "tokens.txt").is_file():
        return False
    for prefix in ("encoder", "decoder", "joiner"):
        matches = list(model_dir.glob(prefix + "*.onnx"))
        if not matches:
            return False
    return True


def _download(url: str, target: Path, proxy: str | None) -> None:
    """流式下载到 target；有代理就显式走 ProxyHandler。"""
    handlers: list[urllib.request.BaseHandler] = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(url, timeout=60) as response, target.open("wb") as sink:
        total = int(response.headers.get("content-length", "0"))
        done = 0
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            sink.write(chunk)
            done += len(chunk)
            if total:
                percent = done * 100 // total
                print(f"\r下载中 {percent:3d}%  {done / 1024 / 1024:.1f} MB", end="", flush=True)
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 sherpa-onnx 中文流式 ASR 模型")
    parser.add_argument("--url", default=DEFAULT_URL, help="模型 tar.bz2 的地址")
    parser.add_argument(
        "--target",
        default=str(DEFAULT_TARGET),
        help="解压目录（默认 data/models/asr-stream）",
    )
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY", ""), help="HTTP(S) 代理")
    args = parser.parse_args()

    target_root = Path(args.target)
    model_dir = target_root / MODEL_DIR_NAME
    if _is_complete(model_dir):
        print("模型已就位：" + str(model_dir))
        return 0

    target_root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".tar.bz2", delete=False) as handle:
        archive = Path(handle.name)
    try:
        print("下载 " + args.url)
        _download(args.url, archive, args.proxy or None)
        print("解压到 " + str(target_root))
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(target_root, filter="data")
    finally:
        archive.unlink(missing_ok=True)

    if not _is_complete(model_dir):
        print("解压后仍缺文件：" + str(model_dir), file=sys.stderr)
        return 1
    print("完成：" + str(model_dir))
    print("提示：若模型放在别处，设 DESKPET_ASR_STREAM_MODEL_DIR 指向该目录。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
