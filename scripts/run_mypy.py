"""在仓库根跑 mypy：分两趟检查 Python 侧（sidecar 与 tools），任一趟失败都不通过。

为什么需要一个包装脚本：mypy 按 cwd 推导模块搜索路径，而 sidecar 的五层包（api / services /
core / adapters / contracts）用的是裸导入，只有 cwd = sidecar/ 时才认得它们（CODE_STYLE §1.1）。
pre-commit 的钩子一律以仓库根为 cwd，所以这里显式切目录，保证「命令行跑」与「提交时跑」结果一致。

tools/ 那一趟相反：`tools.indextts_adapter` 是仓库根下的命名空间包，必须从仓库根看才对得上，
且要加 --explicit-package-bases，否则 mypy 会把它同时算成两个模块名而直接放弃检查。

调用方式：.venv/Scripts/python.exe scripts/run_mypy.py（pre-commit 的 mypy 钩子也走这里）
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "sidecar"
TOOLS_DIR = REPO_ROOT / "tools"
CONFIG_FILE = SIDECAR_DIR / "pyproject.toml"


def main() -> int:
    """先查 sidecar/（cwd 切过去），再查 tools/（从仓库根看），返回合并后的退出码。"""
    if not SIDECAR_DIR.is_dir():
        # 同 check_ps1_bom.py：钩子输出走 cmd 代码页，出错信息用 ASCII 才不会乱码
        print("sidecar/ directory not found; cannot run mypy", file=sys.stderr)
        return 1
    # 用 sys.executable 而非写死 .venv 路径：谁调用这个脚本，就用谁的解释器跑 mypy
    code = subprocess.call([sys.executable, "-m", "mypy", "."], cwd=SIDECAR_DIR)
    if TOOLS_DIR.is_dir():
        code |= subprocess.call(
            [
                sys.executable,
                "-m",
                "mypy",
                "--config-file",
                str(CONFIG_FILE),
                "--explicit-package-bases",
                "tools",
            ],
            cwd=REPO_ROOT,
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
