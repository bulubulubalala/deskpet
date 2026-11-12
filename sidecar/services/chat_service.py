"""文件职责：会话主流程的对外入口（门面，只有导出没有逻辑）。

实现按职责拆在 services/chat/ 下：
- service.py —— 一轮会话怎么组装、记哪些事实、失败怎么收敛；
- stream_runner.py —— 多端点降级 / 重试 / 超时；
- line_parser.py —— 模型输出的不可信行怎么解析；
- memory_bridge.py —— 记忆读写与收尾排期。

调用方（app.py / api/chat.py / 测试）继续从 services.chat_service 取名字，路径不变。
"""

from services.chat.service import (
    USER_HINT_NOT_CONFIGURED,
    USER_HINT_PACK_MISSING,
    ChatService,
    build_chat_service,
)

__all__ = [
    "USER_HINT_NOT_CONFIGURED",
    "USER_HINT_PACK_MISSING",
    "ChatService",
    "build_chat_service",
]
