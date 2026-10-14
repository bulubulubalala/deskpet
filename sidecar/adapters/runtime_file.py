"""文件职责：data/runtime.json 的落盘、读取与退出清理（需求 §6.10）。

依赖方向：adapters -> contracts；实现「怎么存」，不决定「什么时候存」（时序在 main.py）。
谁调用：sidecar/main.py（写 / 删）；测试与调试脚本（读）。
"""

import os
from pathlib import Path

from contracts.runtime import RuntimeInfo

TEMP_SUFFIX = ".tmp"


def write_runtime_file(path: Path, info: RuntimeInfo) -> None:
    """原子写：先写同目录 .tmp 再 os.replace。

    为什么必须原子：Electron 是「轮询到文件出现就读」，普通写入会让它读到半个 JSON，
    那种错误只在启动竞态里偶发，极难复现（需求 §6.10 的握手规则）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + TEMP_SUFFIX)
    temp_path.write_text(info.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temp_path, path)


def read_runtime_file(path: Path) -> RuntimeInfo:
    """读回握手信息（正常读取方是 Electron；Python 侧供测试与排查）。"""
    return RuntimeInfo.model_validate_json(path.read_text(encoding="utf-8"))


def remove_runtime_file(path: Path) -> None:
    """删除握手文件；文件不存在也算成功（崩溃重启后的清理不该再抛异常）。"""
    path.unlink(missing_ok=True)
