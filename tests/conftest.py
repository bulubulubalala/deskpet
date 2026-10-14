"""文件职责：测试公共引导（让契约测试能 import 组合根 sidecar/app.py）。

为什么需要：hatchling 只把 api / services / core / adapters / contracts 五个包装成顶层包，
app.py 不是包；而且仓库根还有一个同名的 Electron 目录 app/，所以必须把 sidecar/ 插到
sys.path 最前面，避免 import app 命中 Electron 目录。
谁调用：pytest 自动加载。
"""

import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parents[1] / "sidecar"
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))
