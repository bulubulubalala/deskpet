"""文件职责：POST /providers/test 的请求/响应契约（需求 §6.13 / T1.14b 的「测试连接」）。

依赖方向：只依赖 pydantic 与 contracts.health 的能力面枚举；被 services 构造、api 序列化，
app/main/ipc.ts 里有同名字段的镜像，字段名由 tests/ipc-contract.test.ts 跨语言对账。

安全约束：**结论契约**（ProviderProbeResult / ProviderTestResponse）没有 api_key，以后也不许加——
探测结论会经 IPC 进界面、进日志，密钥一旦进来就泄露了（§6.13：界面只显示「已配置 / 未配置」）。
例外只有请求里的 ProviderTestOverrides：设置窗「测试连接」要测当前未保存表单，密钥必须随请求
到达 sidecar；它只在本机回环 + 进程 token 下传输，不落盘、不写日志、不回声，且用 SecretStr
防止 repr / model_dump 意外带出。
"""

from typing import Literal

from pydantic import BaseModel, Field, SecretStr

from contracts.health import ProviderCapability


class ProviderTestOverrides(BaseModel):
    """测试连接时可选的未保存表单值；省略 = 沿用已保存配置，空串 = 这次不用该值。"""

    provider: Literal["cloud", "local", "edge"] | None = None
    preset: str | None = Field(default=None, max_length=64)
    cloud_base_url: str | None = None
    cloud_model: str | None = None
    cloud_api_key: SecretStr | None = None
    local_base_url: str | None = None
    local_model: str | None = None
    local_token: SecretStr | None = None
    fallback_base_url: str | None = None
    fallback_model: str | None = None


class ProviderTestRequest(BaseModel):
    """「测试连接」按钮点的是哪一个能力面，以及要不要用界面里还没保存的值。"""

    capability: ProviderCapability = Field(description="要探测的能力面（llm / asr / tts）")
    overrides: ProviderTestOverrides | None = Field(
        default=None, description="未保存表单值；只有本机设置窗会传，密钥不落盘不日志"
    )


class ProviderModelsRequest(BaseModel):
    """拉取云端 OpenAI 兼容端点的模型列表（设置窗「获取模型列表」）。"""

    capability: ProviderCapability = Field(description="目前只支持 llm")
    overrides: ProviderTestOverrides | None = Field(
        default=None, description="未保存表单值；密钥只走本机回环，不落盘不日志"
    )


class ProviderModelsResponse(BaseModel):
    """模型 id 列表；detail 是失败时给人看的一句话，成功时为空。"""

    capability: ProviderCapability
    models: list[str] = Field(default_factory=list)
    detail: str = ""


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
