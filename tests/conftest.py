"""文件职责：测试公共引导（让契约测试能 import 组合根 sidecar/app.py）。

为什么需要：hatchling 只把 api / services / core / adapters / contracts 五个包装成顶层包，
app.py 不是包；而且仓库根还有一个同名的 Electron 目录 app/，所以必须把 sidecar/ 插到
sys.path 最前面，避免 import app 命中 Electron 目录。
谁调用：pytest 自动加载。
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_ROOT = REPO_ROOT / "sidecar"
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))
# 仓库根用 append（不是 insert）：必须让 sidecar/ 继续排在前面，否则 `import app` 会命中 Electron 的 app/。
# 需要它的是 tools/ 下的适配器包（tools.indextts_adapter）。
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))
