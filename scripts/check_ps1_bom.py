"""检查 .ps1 脚本是否带 UTF-8 BOM（本项目被这条坑过三次，值得自动拦住）。

Windows PowerShell 5.1 对没有 BOM 的脚本按本地代码页（简体中文环境是 GBK）解码：脚本里的中文
会变乱码，引号配对被破坏，报 TerminatorExpectedAtEndOfString，而且整份脚本一行都不执行。
所以仓库里的 .ps1 一律存成 UTF-8 with BOM；本脚本在提交时检查（也能手动跑）。

用法：.venv/Scripts/python.exe scripts/check_ps1_bom.py <文件…>（pre-commit 的 ps1-bom 钩子也走这里）
"""

from __future__ import annotations

import sys
from pathlib import Path

UTF8_BOM = b"\xef\xbb\xbf"


def has_bom(path: Path) -> bool:
    """读前 3 个字节判断是否为 UTF-8 BOM。"""
    with path.open("rb") as handle:
        return handle.read(3) == UTF8_BOM


def main(argv: list[str]) -> int:
    """逐个检查传入的文件；有关掉 BOM 的就报错并非零退出。"""
    bad: list[str] = []
    for raw in argv:
        path = Path(raw)
        if path.suffix.lower() != ".ps1" or not path.is_file():
            continue
        if not has_bom(path):
            bad.append(str(path))
    if bad:
        # 提示信息刻意用 ASCII：钩子的 stdout 会经过 cmd 的控制台代码页（本机是 GBK），
        # 中文在这里会变成乱码，反而看不清是哪几个文件出了问题。
        print("Missing UTF-8 BOM (PowerShell 5.1 would decode these as GBK and fail to run them):")
        for item in bad:
            print(f"  {item}")
        print("Fix: rewrite with BOM, e.g. Set-Content -Path <file> -Encoding utf8BOM")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
