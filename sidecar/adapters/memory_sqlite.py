"""文件职责：SQLCipher 记忆库的对外入口（需求 §6.4 四层阶梯 / §6.5 整库加密）。

实现按域拆在 adapters/memory_store/（原来的单文件 2000+ 行，改一行要通读全文）：
- store.py      组装类 + 连接生命周期 + open_memory_store
- messages.py   L0 原文与覆盖标记
- memories.py   L1 记忆条目（含检索）
- periods.py    L2 时间线
- diary.py / graph.py / summaries.py / embeddings.py / maintenance.py / character_state.py
- base.py       共享状态与错误翻译；rows.py / vectors.py 是纯函数

依赖方向：adapters → core（只用 core.memory 的数据类型与异常）；不 import services。
谁调用：services.memory_service 通过 MemoryStore 协议使用；composition root 负责建库。
线程安全：一条连接 + 一把可重入锁（FastAPI 的同步端点可能落在线程池里）。
"""

from __future__ import annotations

from adapters.memory_schema import SCHEMA_VERSION
from adapters.memory_store.store import MemorySqliteStore, open_memory_store

__all__ = [
    "SCHEMA_VERSION",
    "MemorySqliteStore",
    "open_memory_store",
]
