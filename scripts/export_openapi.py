"""文件职责：生成契约快照（sidecar/contracts/openapi.json 与 llm_events.schema.json）。

为什么提交快照：契约变了就必须一起更新快照，契约测试会拿实际 schema 与快照对账，
防止「改了一侧忘了另一侧」或「字段被悄悄改掉」（CODE_STYLE §1.8）。
依赖方向：脚本 -> app（组合根）与 contracts；不 import 任何业务实现。
谁调用：改了契约后手工执行（用 .venv 里的解释器）：python scripts/export_openapi.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_ROOT = REPO_ROOT / "sidecar"
CONTRACTS_DIR = SIDECAR_ROOT / "contracts"

if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


def dump(path: Path, payload: Any) -> None:
    """统一的序列化方式（UTF-8 + 缩进 + 键排序），保证快照可 diff、跨机器一致。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    print(f"已写入 {path.relative_to(REPO_ROOT)}")


def main() -> None:
    """导出 HTTP 契约与 LLM 事件协议两份快照。"""
    from app import create_app
    from contracts.events import LLM_EVENT_ADAPTER

    dump(CONTRACTS_DIR / "openapi.json", create_app().openapi())
    dump(CONTRACTS_DIR / "llm_events.schema.json", LLM_EVENT_ADAPTER.json_schema())


if __name__ == "__main__":
    main()
