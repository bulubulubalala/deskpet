"""工具链自检：确认 venv 能 import 到 sidecar 各分层包，且解释器满足版本基线。

职责：M0 / T0.2 的环境验收（`pytest -q` 必须能跑通）；不测任何业务逻辑。
依赖方向：只依赖 sidecar 的包与标准库，不触碰 api / services 的内部实现。
谁调用：本地与（未来的）CI 的 pytest。
"""

import sys
from importlib import import_module

import pytest


def test_python_version_meets_baseline() -> None:
    """解释器必须 >= 3.12（CODE_STYLE §9：Python 基线 3.12）。"""
    assert sys.version_info >= (3, 12)


@pytest.mark.parametrize("layer", ["api", "services", "core", "adapters", "contracts"])
def test_sidecar_layers_importable(layer: str) -> None:
    """五层包都必须可导入，且声明了出口 __all__（CODE_STYLE §1.3）。"""
    module = import_module(layer)
    assert isinstance(module.__all__, list)
