"""文件职责：sidecar 运行时配置（CODE_STYLE §1.6：可调参数集中于此）。

依赖方向：只依赖标准库，不 import 任何业务模块。
谁调用：sidecar/main.py 启动时读一次；测试用 load_settings(env={...}) 注入。
约定：这里的默认值必须与仓库根 .env.example 保持一致。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8737
DEFAULT_LOG_LEVEL = "info"
RUNTIME_FILE_NAME = "runtime.json"
SOURCE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = SOURCE_ROOT / "data"


@dataclass(frozen=True, slots=True)
class Settings:
    """一次启动用到的全部配置（不可变，避免运行期被偷偷改掉）。"""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    data_dir: Path = DEFAULT_DATA_DIR
    log_level: str = DEFAULT_LOG_LEVEL

    @property
    def runtime_file(self) -> Path:
        """Electron 与 sidecar 的握手文件路径（需求 §6.10）。"""
        return self.data_dir / RUNTIME_FILE_NAME


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """从环境变量读配置。

    端口非法时直接抛错：宁可启动失败并让 Electron 报「sidecar 起不来」，
    也不要静默落到一个用户没配过的端口上（那种问题在真机上极难排查）。
    """
    source = os.environ if env is None else env
    raw_port = source.get("DESKPET_SIDECAR_PORT", str(DEFAULT_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError("DESKPET_SIDECAR_PORT 不是整数：" + repr(raw_port)) from exc
    if not 0 <= port <= 65535:
        raise ValueError("DESKPET_SIDECAR_PORT 超出 0-65535：" + raw_port)
    raw_data_dir = source.get("DESKPET_DATA_DIR", "").strip()
    return Settings(
        host=source.get("DESKPET_SIDECAR_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=port,
        data_dir=Path(raw_data_dir) if raw_data_dir else DEFAULT_DATA_DIR,
        log_level=source.get("DESKPET_LOG_LEVEL", DEFAULT_LOG_LEVEL).strip().lower()
        or DEFAULT_LOG_LEVEL,
    )
