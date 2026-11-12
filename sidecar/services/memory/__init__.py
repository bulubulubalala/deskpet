"""文件职责：记忆用例层（需求 §6.4 / §5 F3）：记什么、注入什么、失败怎么办。

按域拆在同目录：base（依赖与降级）/ recall（注入装配）/ embeddings（语义索引）/
memories（条目）/ messages（原文与摘要）/ timeline（时间线与日记）/ relations（关系与待办）。

依赖方向：services -> adapters（库与密钥由 build_memory_service 建好注入）/ core / contracts；
不 import api。
谁调用：sidecar/app.py 组合根；api/memory/ 的管理端点；ChatService 经 core.memory.MemoryGateway
协议在每轮对话里读写。
约定：
- 记忆是增强项不是对话链路的必需件：读失败当作「没有记忆」，写失败只记日志 + 上报环境事件，
  绝不把 DP-MEM-* 抛进 /chat/stream（§6.4）。管理端点反过来——用户主动点「记住 / 清空」时必须
  看到失败原因，所以那一组方法直接抛 core.errors.MemoryStoreError（DP-MEM-*）。
- 注入预算按固定优先级裁剪：历史 → L0 片段 → L1 → L2，L3 永不裁层（太长只截断）。
- 这里不做摘要、不调模型：阶梯压缩是 T2.1b 的活，本层只负责「按预算取与装」。
"""

from __future__ import annotations

from .service import MemoryService, build_memory_service

__all__ = ["MemoryService", "build_memory_service"]
