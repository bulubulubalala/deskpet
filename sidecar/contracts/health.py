"""文件职责：/health 的响应契约（需求 §6.3 health 行 + §7.2 心跳）。

依赖方向：只依赖 pydantic；被 services/health_service.py 构造、api/health.py 序列化。
app/main/ipc.ts 里有同名字段的镜像，字段名由 tests/ipc-contract.test.ts 跨语言对账。
"""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

HealthStatus = Literal["ok", "degraded", "starting"]


class ModuleName(StrEnum):
    """会被心跳观察的模块名（与 app/main/ipc.ts 的 MODULE_NAMES 对齐）。"""

    TTS = "tts"
    ASR = "asr"
    LLM = "llm"
    MEMORY = "memory"
    SCREEN = "screen"
    STAGE = "stage"


class ModuleState(StrEnum):
    """模块状态；offline 由主进程判定（心跳连续失败），sidecar 内部一般不自己置 offline。"""

    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"
    OFFLINE = "offline"


class ModuleHealth(BaseModel):
    """单个模块的心跳条目；detail 只写短状态描述，禁止放敏感内容（CODE_STYLE §6）。"""

    name: ModuleName
    state: ModuleState
    detail: str | None = None


class GpuUsage(BaseModel):
    """sidecar 自己占用的显存（MB）；探测不到设备时 total_mb 为 None。"""

    loaded_mb: int = Field(default=0, ge=0)
    total_mb: int | None = None


class HealthResponse(BaseModel):
    """GET /health 的响应体；必须 ≤10ms 返回、不加载模型、不抢 GPU 锁（需求 §6.3）。"""

    status: HealthStatus = "ok"
    uptime_s: float = Field(ge=0, description="sidecar 进程已运行秒数")
    modules: list[ModuleHealth]
    gpu: GpuUsage = Field(default_factory=GpuUsage)
    version: str
