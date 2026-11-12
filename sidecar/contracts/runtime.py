"""文件职责：runtime.json 的数据形状（Electron ← sidecar 的端口握手，需求 §6.10）。

依赖方向：只依赖 pydantic，与 sidecar/contracts/routes.py 同属跨进程契约。
谁调用：adapters/runtime_file.py 负责落盘；Electron 主进程读同名 JSON（TS 侧字段名要对账）。
"""

from pydantic import BaseModel, ConfigDict, Field


class RuntimeInfo(BaseModel):
    """监听成功后写入 data/runtime.json 的内容；只给本机进程看，不含业务数据。"""

    model_config = ConfigDict(extra="forbid")

    pid: int = Field(description="sidecar 进程号；Electron 退出时兜底清理用")
    host: str = Field(description="监听地址，固定 127.0.0.1（只回环）")
    port: int = Field(ge=0, le=65535, description="真实监听端口（可能与配置的首选端口不同）")
    token: str = Field(min_length=16, description="本次启动新生成的共享密钥，每次重启都换")
    started_at: str = Field(description="ISO 8601（UTC）启动时间")
    version: str = Field(description="sidecar 版本，Electron 用它判断契约是否匹配")
