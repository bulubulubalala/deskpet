"""文件职责：sidecar HTTP API 的请求 / 响应模型（需求 §6.3 表格逐行落地）。

依赖方向：只依赖 pydantic。
谁调用：api/ 各路由（M0 只有 /health 真实现，其余路由 M1 起逐个接上）与契约测试。
"""

from typing import Literal

from pydantic import BaseModel, Field

# 8 维情感向量顺序（需求 §3.3 实测顺序，不可改）：喜, 怒, 哀, 惧, 厌恶, 低落, 惊喜, 平静
EMOTION_VECTOR_DIMENSIONS = (
    "joy",
    "anger",
    "sadness",
    "fear",
    "disgust",
    "low",
    "surprise",
    "calm",
)
EMOTION_VECTOR_SIZE = len(EMOTION_VECTOR_DIMENSIONS)


class AsrQuery(BaseModel):
    """POST /asr 的 query 参数；请求体是原始 PCM（application/octet-stream）。"""

    sample_rate: int = Field(default=16000, ge=8000, le=48000)
    lang: str | None = None
    request_id: str


class AsrResponse(BaseModel):
    """识别结果；confidence 为 0 时上层按「没听清」处理（需求 §6.7）。"""

    text: str
    confidence: float = Field(ge=0, le=1)
    duration_s: float = Field(ge=0)
    language: str | None = None


class TtsRequest(BaseModel):
    """合成请求；单句建议 ≤40 字（events.MAX_SENTENCE_CHARS），超长由上层切分。"""

    text: str = Field(min_length=1)
    voice_id: str
    lang: Literal["zh", "ja", "en"] = "zh"
    emo_vector: list[float] = Field(
        default_factory=lambda: [0.0] * EMOTION_VECTOR_SIZE,
        min_length=EMOTION_VECTOR_SIZE,
        max_length=EMOTION_VECTOR_SIZE,
    )
    emo_weight: float = Field(default=0.6, ge=0, le=1)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    request_id: str


class TtsCancelRequest(BaseModel):
    """取消一次未完成的合成（打断是一等公民，CODE_STYLE §1.7）。"""

    request_id: str


class TtsCancelResponse(BaseModel):
    """cancelled=False 表示该 request_id 已经结束，属于正常情况。"""

    cancelled: bool
    reason: str | None = None


class ChatStreamRequest(BaseModel):
    """POST /chat/stream 的请求体；响应是 SSE（§6.2 的逐行 JSON 事件）。"""

    session_id: str
    char_id: str
    text: str = Field(min_length=1)
    input_mode: Literal["text", "voice"] = "text"
    screen_text: str | None = Field(
        default=None,
        description="屏幕 OCR 文本；按不可信输入处理（需求 §7.4）",
    )
    client_ts: float | None = None


class MemoryHit(BaseModel):
    """一条检索结果；score 已含重要度与时间衰减（需求 §6.4）。"""

    id: int
    text: str
    importance: float = Field(ge=0, le=1)
    occurred_at: str
    score: float


class MemorySearchQuery(BaseModel):
    """GET /memory/search 的 query 参数；检索限定在同一个 char_id 分区内（需求 §6.4）。"""

    query: str = Field(min_length=1)
    char_id: str
    limit: int = Field(default=20, ge=1, le=100)
    min_importance: float = Field(default=0.0, ge=0, le=1)


class MemorySearchResponse(BaseModel):
    """检索结果列表，按 score 降序。"""

    items: list[MemoryHit]


class MemoryWriteRequest(BaseModel):
    """写入一条记忆；dedup 由 services 层负责（需求 §6.3）。"""

    char_id: str
    kind: Literal["fact", "preference", "event"]
    text: str = Field(min_length=1)
    importance: float = Field(default=0.5, ge=0, le=1)
    occurred_at: str | None = None
    source: Literal["chat", "user", "system"] = "chat"


class MemoryWriteResponse(BaseModel):
    """deduped=True 表示命中已有记忆，没有新增行。"""

    id: int
    deduped: bool


class MemoryDeleteResponse(BaseModel):
    """deleted=False 表示该 id 不存在（幂等，不报错）。"""

    deleted: bool


class MemoryListItem(BaseModel):
    """管理界面里的一条记忆（T2.1a 新增；不含内部去重键与数据库主键细节）。

    kind / tier 是普通字符串而不是 Literal：库里允许历史遗留值，响应不该因此 500。
    """

    id: int
    kind: str
    tier: str
    text: str
    importance: float = Field(ge=0, le=1)
    created_at: str
    last_used_at: str
    used_count: int = Field(ge=0)


class MemoryListQuery(BaseModel):
    """GET /memory/list 的 query 参数；kind / tier 留空表示不限（§6.4 的管理入口）。"""

    char_id: str
    kind: Literal["", "fact", "preference", "event", "action"] = ""
    tier: str = ""
    min_importance: float = Field(default=0.0, ge=0, le=1)
    limit: int = Field(default=50, ge=1, le=200)


class MemoryListResponse(BaseModel):
    """一个角色的记忆列表，按重要度、时间倒序。"""

    items: list[MemoryListItem]


class MemoryClearRequest(BaseModel):
    """清空一个角色的记忆；keep_days 给了就只清更早的（隐私要求，§5 F3）。"""

    char_id: str
    keep_days: float | None = Field(default=None, ge=0)


class MemoryClearResponse(BaseModel):
    """deleted 是实际删除的记忆条数（不含历史消息与摘要）。"""

    deleted: int = Field(ge=0)


class UsageRecordRequest(BaseModel):
    """主进程上报的一条使用事实（T2.3-C1/C2）；char_id 由主进程带上，免得串角色。

    fact 目前只有窗口晃动；T2.3-C2 会加 `char_hit`（立绘部位点击 + streak）。
    """

    fact: Literal["window_shake"]
    char_id: str = ""


class UsageRecordResponse(BaseModel):
    """recorded=false 表示没有可承接的会话或记录开关关着——这不是错误。"""

    recorded: bool


class ScreenCaptureResponse(BaseModel):
    """屏幕识别结果；原文只在内存里流转，不落盘（需求 §7.3）。"""

    ocr_text: str
    confidence: float = Field(ge=0, le=1)
    captured_at: str
    width: int = Field(ge=0)
    height: int = Field(ge=0)


class PersonaImportRequest(BaseModel):
    """导入自有角色包；keep_memories 只影响已有记忆是否保留（角色包本身不含记忆，D12）。"""

    path: str
    overwrite: bool = False
    keep_memories: bool = True


class PersonaImportResponse(BaseModel):
    """体检结果；missing_fields 里的字段允许先空着跑（需求 §5 F6）。"""

    char_id: str
    display_name: str
    warnings: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
