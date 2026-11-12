"""文件职责：服务层共用的「模型端口」类型别名（只描述形状，不含实现）。

为什么单独一份：ChatService 与三个记忆后台服务都要注入「怎么造客户端」，原先四处各写
一条一模一样的 Callable 声明；改一处漏一处，注入方与实现方的类型就会悄悄分叉。

依赖方向：services -> adapters（只取类型，不用实现）/ core；不 import api。
谁调用：services/chat/service.py、services/memory_*_service.py 的构造函数签名。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from adapters.llm_openai import LlmEndpoint, OpenAiChatClient

#: 造一个真实 HTTP 客户端；生产路径由组合根决定超时，测试里换成假客户端。
ClientFactory = Callable[[LlmEndpoint], OpenAiChatClient]

#: 退避用的睡眠；测试里换成「记下延迟、立刻返回」的假实现。
Sleep = Callable[[float], Awaitable[None]]

__all__ = ["ClientFactory", "Sleep"]
