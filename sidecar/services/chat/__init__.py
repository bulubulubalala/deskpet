"""会话主流程的内部模块（对外入口仍是 services/chat_service.py）。

service.py       一轮怎么组装、记什么、怎么收尾；
stream_runner.py 模型调用：降级、重试、两段超时、断流；
line_parser.py   模型输出的不可信行 → 事件；
memory_bridge.py 记忆读写、角色状态、收尾后的后台整理。
"""

__all__: list[str] = []
