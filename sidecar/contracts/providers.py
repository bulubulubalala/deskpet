"""文件职责：POST /providers/test 的请求/响应契约（需求 §6.13 / T1.14b 的「测试连接」）。

依赖方向：只依赖 pydantic 与 contracts.health 的能力面枚举；被 services 构造、api 序列化，
app/main/ipc.ts 里有同名字段的镜像，字段名由 tests/ipc-contract.test.ts 跨语言对账。

安全约束：本文件的模型**没有** api_key 字段，以后也不许加——探测结论会经 IPC 进界面、
进日志，密钥一旦进来就泄露了（§6.13：界面只显示「已配置 / 未配置」）。
"""

from pydantic import BaseModel, Field

from contracts.health import ProviderCapability


class ProviderTestRequest(BaseModel):
    """「测试连接」按钮点的是哪一个能力面。"""

    capability: ProviderCapability = Field(description="要探测的能力面（llm / asr / tts）")


class ProviderProbeResult(BaseModel):
    """单个候选端点的探测结论；provider 是候选顺序里的身份（cloud / local / fallback）。"""

    provider: str = Field(description="端点在候选顺序里的身份：cloud / local / fallback")
    base_url: str | None = Field(default=None, description="探测的端点地址；本地引擎为 None")
    model: str | None = Field(default=None, description="探测请求用的模型名；无需模型时为 None")
    ok: bool = Field(description="是否可用")
    detail: str = Field(description="给人看的短结论；绝不含密钥")
    elapsed_ms: int = Field(ge=0, description="探测耗时（毫秒）")


class ProviderTestResponse(BaseModel):
    """一次「测试连接」的全部结论：LLM 面可能有多个候选，ASR / TTS 面各一条。"""

    capability: ProviderCapability
    results: list[ProviderProbeResult]
