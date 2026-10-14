"""在仓库根跑 mypy：切到 sidecar/ 后用它的 pyproject.toml 检查整个 Python 侧。

为什么需要一个包装脚本：mypy 按 cwd 推导模块搜索路径，而 sidecar 的五层包（api / services /
core / adapters / contracts）用的是裸导入，只有 cwd = sidecar/ 时才认得它们（CODE_STYLE §1.1）。
pre-commit 的钩子一律以仓库根为 cwd，所以这里显式切目录，保证「命令行跑」与「提交时跑」结果一致。

调用方式：.venv/Scripts/python.exe scripts/run_mypy.py（pre-commit 的 mypy 钩子也走这里）
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "sidecar"


def main() -> int:
    """在 sidecar/ 目录下运行 mypy，返回它的退出码。"""
    if not SIDECAR_DIR.is_dir():
        # 同 check_ps1_bom.py：钩子输出走 cmd 代码页，出错信息用 ASCII 才不会乱码
        print("sidecar/ directory not found; cannot run mypy", file=sys.stderr)
        return 1
    # 用 sys.executable 而非写死 .venv 路径：谁调用这个脚本，就用谁的解释器跑 mypy
    return subprocess.call([sys.executable, "-m", "mypy", "."], cwd=SIDECAR_DIR)


if __name__ == "__main__":
    raise SystemExit(main())
