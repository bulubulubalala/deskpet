"""文件职责：记忆 HTTP 路由包（按域拆分，入口仍是 build_memory_router）。

子模块：shared（失败信封）/ items（行 → 接口模型）/ memories / messages /
timeline / relations / embeddings / context / service（装配）。
依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 只 import 本包。
"""

from __future__ import annotations

from .service import build_memory_router

__all__ = ["build_memory_router"]
