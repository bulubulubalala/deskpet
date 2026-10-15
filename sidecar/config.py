"""文件职责：sidecar 运行时配置（CODE_STYLE §1.6：可调参数集中于此）。

依赖方向：只依赖标准库，不 import 任何业务模块。
谁调用：sidecar/main.py 启动时读一次；测试用 load_settings(env={...}) 注入。
约定：这里的默认值必须与仓库根 .env.example 保持一致。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8737
DEFAULT_LOG_LEVEL = "info"
RUNTIME_FILE_NAME = "runtime.json"
CHARACTERS_DIR_NAME = "characters"
LOG_DIR_NAME = "logs"
LOG_FILE_NAME = "deskpet.log"
#: 需求 §6.7：日志滚动保留 7 天 / 20MB
DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_LOG_RETENTION_DAYS = 7
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def default_data_dir(*, frozen: bool | None = None, executable: str | None = None) -> Path:
    """返回数据目录默认值（参数可注入，便于单测，T0.8）。

    源码态：仓库 data/（与 .env.example 一致）。
    打包态（PyInstaller onedir）：__file__ 落在 bundle 内，往它旁边写等于往只读资源里写，
    故改用「exe 所在目录 / data」；实际运行时 Electron 一定会传 DESKPET_DATA_DIR
    （打包态落 userData/data），这里的默认值只服务于「单独跑 sidecar.exe 自检」这种场景。
    """
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        exe = sys.executable if executable is None else executable
        return Path(exe).parent / "data"
    return SOURCE_ROOT / "data"


DEFAULT_DATA_DIR = default_data_dir()


def default_characters_dir(*, frozen: bool | None = None, executable: str | None = None) -> Path:
    """返回角色包目录默认值（F6 / §6.1）。

    源码态：仓库根 characters/（与 §9.1 的目录结构一致）。
    打包态：exe 旁边的 characters/；实际运行时 Electron 一定会传 DESKPET_CHARACTERS_DIR
    （打包态落 userData/characters，因为安装目录通常不可写，角色包又必须可写）。
    """
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        exe = sys.executable if executable is None else executable
        return Path(exe).parent / CHARACTERS_DIR_NAME
    return SOURCE_ROOT.parent / CHARACTERS_DIR_NAME


DEFAULT_CHARACTERS_DIR = default_characters_dir()


@dataclass(frozen=True, slots=True)
class Settings:
    """一次启动用到的全部配置（不可变，避免运行期被偷偷改掉）。"""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    data_dir: Path = DEFAULT_DATA_DIR
    characters_dir: Path = DEFAULT_CHARACTERS_DIR
    log_level: str = DEFAULT_LOG_LEVEL
    log_max_bytes: int = DEFAULT_LOG_MAX_BYTES
    log_retention_days: int = DEFAULT_LOG_RETENTION_DAYS

    @property
    def runtime_file(self) -> Path:
        """Electron 与 sidecar 的握手文件路径（需求 §6.10）。"""
        return self.data_dir / RUNTIME_FILE_NAME

    @property
    def log_file(self) -> Path:
        """结构化日志文件（<数据目录>/logs/deskpet.log）。"""
        return self.data_dir / LOG_DIR_NAME / LOG_FILE_NAME


def _positive_int(source: Mapping[str, str], key: str, default: int) -> int:
    """读一个正整数环境变量；非法值直接抛错（配错了要说出来，不要静默用默认值）。"""
    raw = source.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(key + " 不是整数：" + repr(raw)) from exc
    if value <= 0:
        raise ValueError(key + " 必须为正整数：" + raw)
    return value


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
    raw_characters_dir = source.get("DESKPET_CHARACTERS_DIR", "").strip()
    return Settings(
        host=source.get("DESKPET_SIDECAR_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=port,
        data_dir=Path(raw_data_dir) if raw_data_dir else DEFAULT_DATA_DIR,
        characters_dir=(Path(raw_characters_dir) if raw_characters_dir else DEFAULT_CHARACTERS_DIR),
        log_level=source.get("DESKPET_LOG_LEVEL", DEFAULT_LOG_LEVEL).strip().lower()
        or DEFAULT_LOG_LEVEL,
        log_max_bytes=_positive_int(source, "DESKPET_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES),
        log_retention_days=_positive_int(
            source, "DESKPET_LOG_RETENTION_DAYS", DEFAULT_LOG_RETENTION_DAYS
        ),
    )
