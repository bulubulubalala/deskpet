"""文件职责：语音识别模型的预下载状态契约（D7）。

依赖方向：contracts 最内层，只依赖 pydantic；任何层都可以 import。
谁调用：services/asr_model_service.py 组装响应、api/asr.py 声明 response_model、
app/main 的 sidecar 客户端按它解析。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

#: 四种状态：就绪 / 缺失 / 下载中 / 上次下载失败
AsrModelStatus = Literal["ready", "missing", "downloading", "error"]


class AsrModelState(BaseModel):
    """模型下载状态；progress 在估不出总量时为 0，界面不要把它当「没开始」。"""

    status: AsrModelStatus
    provider: str
    model: str
    downloaded_bytes: int = Field(default=0, ge=0)
    estimated_bytes: int = Field(default=0, ge=0)
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    message: str = ""
    user_hint: str = ""
