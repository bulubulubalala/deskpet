"""文件职责：T0.8 打包相关的配置测试——默认数据目录在源码态与打包态必须不同。

为什么单列：打包后 __file__ 指向 bundle 内部，若默认数据目录仍按源码路径推导，
sidecar 会把 runtime.json / 日志写进只读资源目录，表现为「起来就崩」或「文件写不进去」，
而这类错误在开发态永远复现不出来（CODE_STYLE §7：测试必须无硬件可跑，且覆盖真实分支）。
"""

from __future__ import annotations

from pathlib import Path

import config
from config import default_characters_dir, default_data_dir, load_settings


def test_source_mode_data_dir_is_repo_data() -> None:
    """源码态：默认数据目录仍是仓库根 data/，与 .env.example 保持一致。"""
    assert default_data_dir(frozen=False) == config.SOURCE_ROOT / "data"


def test_frozen_mode_data_dir_sits_next_to_executable(tmp_path: Path) -> None:
    """打包态：默认数据目录落在 sidecar.exe 旁边，而不是 bundle 内部的 __file__ 旁边。"""
    executable = tmp_path / "sidecar.exe"
    assert default_data_dir(frozen=True, executable=str(executable)) == tmp_path / "data"


def test_env_data_dir_overrides_default(tmp_path: Path) -> None:
    """DESKPET_DATA_DIR 优先级最高（Electron 打包态就是靠它把数据落到 userData）。"""
    settings = load_settings(env={"DESKPET_DATA_DIR": str(tmp_path)})
    assert settings.data_dir == tmp_path
    assert settings.runtime_file == tmp_path / "runtime.json"
    assert settings.log_file == tmp_path / "logs" / "deskpet.log"


def test_source_mode_characters_dir_is_repo_characters() -> None:
    """源码态：角色包目录默认是仓库根 characters/（§9.1）。"""
    assert default_characters_dir(frozen=False) == config.SOURCE_ROOT / "characters"


def test_env_characters_dir_overrides_default(tmp_path: Path) -> None:
    """DESKPET_CHARACTERS_DIR 优先级最高：打包态角色包必须落在可写的 userData 下。"""
    settings = load_settings(env={"DESKPET_CHARACTERS_DIR": str(tmp_path)})
    assert settings.characters_dir == tmp_path
