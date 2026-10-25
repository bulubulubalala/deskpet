"""文件职责：sidecar HTTP API 的请求 / 响应模型（需求 §6.3 表格逐行落地）。

依赖方向：只依赖 pydantic。
谁调用：api/ 各路由（M0 只有 /health 真实现，其余路由 M1 起逐个接上）与契约测试。
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

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


class ChatInteractionRegion(BaseModel):
    """互动命中的一个部位（hits.json v2 的 regions[]，T2.3-C2c）。"""

    id: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=48)


class ChatInteraction(BaseModel):
    """互动事实（T2.3-C2c）：触摸立绘这类「不是用户说的话」的输入。

    一条互动 = 一次触摸会话：手势 + 命中的部位 + 力度（次数 / 时长）。
    渲染层算手势用的中间量（间隔、位移、轨迹）不进契约——对提示词没有意义。
    """

    gesture: Literal["tap", "stroke", "hold", "knead", "pat"] = "tap"
    regions: list[ChatInteractionRegion] = Field(default_factory=list, max_length=3)
    count: int = Field(default=1, ge=1, le=999)
    duration_ms: int = Field(default=0, ge=0, le=600000)


class ChatStreamRequest(BaseModel):
    """POST /chat/stream 的请求体；响应是 SSE（§6.2 的逐行 JSON 事件）。"""

    session_id: str
    char_id: str
    text: str = ""
    input_mode: Literal["text", "voice"] = "text"
    screen_text: str | None = Field(
        default=None,
        description="屏幕 OCR 文本；按不可信输入处理（需求 §7.4）",
    )
    client_ts: float | None = None
    interaction: ChatInteraction | None = Field(
        default=None,
        description="部位点击等互动事实；有它时 text 可以为空（T2.3-C2b）。",
    )
    proactive: bool = Field(default=False, description="主动陪伴触发的轮次，允许 text 为空。")
    proactive_kind: str = Field(
        default="", max_length=32, description="主动类型，供提示词选择分寸。"
    )
    app_context: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="主进程允许列表内的应用动态，作为可信上下文注入。",
    )

    @model_validator(mode="after")
    def _require_something_to_answer(self) -> "ChatStreamRequest":
        """两者都空就没东西可回：契约层直接 422（主动陪伴轮次除外）。"""
        if not self.text.strip() and self.interaction is None and not self.proactive:
            raise ValueError("text 和 interaction 不能同时为空")
        return self


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
    source: Literal["chat", "user", "system", "screen"] = "chat"


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
    char_id: str = ""
    kind: str
    tier: str
    text: str
    importance: float = Field(ge=0, le=1)
    created_at: str
    last_used_at: str
    used_count: int = Field(ge=0)
    source_msg_ids: str = ""


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


class MemoryEditRequest(BaseModel):
    """PATCH /memory/{memory_id} 的请求体（T2.3-B2）：只改文本与重要度。

    kind / tier / 时间戳是压缩与检索链路的输入，改它们会让 covered_by 与排序对不上。
    """

    text: str = Field(min_length=1, max_length=500)
    importance: float | None = Field(default=None, ge=0, le=1)
    kind: Literal["fact", "preference", "event", "action"] | None = None


class MemoryEditResponse(BaseModel):
    """编辑结果：updated=False 表示该 id 不存在（幂等，不报错）。

    merged=True 表示改完与同角色另一条撞了去重键，两条并成了一条，item 是留下来的那条。
    """

    updated: bool
    merged: bool = False
    item: MemoryListItem | None = None


class MemoryClearRequest(BaseModel):
    """完整重置一个角色：原文、事实、摘要、状态与使用统计都不保留。"""

    char_id: str


class MemoryClearResponse(BaseModel):
    """deleted 是本次完整重置删除的总条数（含原文、事实、摘要与统计）。"""

    deleted: int = Field(ge=0)


class MemoryMessageItem(BaseModel):
    """开发者模式「原文」页的一行历史消息（T2.3-B1）。

    covered_by 是覆盖它的摘要 id，0 表示还没进过压缩链路；原文只读，界面据此标灰。
    """

    message_id: int = Field(ge=1)
    session_id: str
    role: str
    text: str
    created_at: str
    token_len: int = Field(ge=0)
    covered_by: int = Field(default=0, ge=0)


class MemoryMessagesQuery(BaseModel):
    """GET /memory/messages 的 query 参数：按 id 倒序翻页（before_id 取更早的）。"""

    char_id: str
    limit: int = Field(default=100, ge=1, le=500)
    before_id: int | None = Field(default=None, ge=1)


class MemoryMessagesResponse(BaseModel):
    """一页历史原文；has_more=True 表示还有更早的，可以用 before_id 继续翻。"""

    items: list[MemoryMessageItem]
    has_more: bool = False


class MemorySummaryItem(BaseModel):
    id: int
    char_id: str
    tier: int = Field(ge=1, le=3)
    text: str
    covers_from: str
    covers_to: str
    source_ids: str = ""
    created_at: str
    archived_at: str


class MemorySummariesQuery(BaseModel):
    char_id: str
    limit: int = Field(default=100, ge=1, le=500)


class MemorySummariesResponse(BaseModel):
    items: list[MemorySummaryItem]


class MemorySummaryEditRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class MemoryMessageEditRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class MemoryContextQuery(BaseModel):
    """GET /memory/context 的 query 参数：query 留空 = 「没有新话题」时的基础注入。"""

    char_id: str
    query: str = ""


class MemoryContextItem(BaseModel):
    """注入预览里的一条内容；ref_id 是记忆 id（历史原文没有，为 0）。"""

    text: str
    tokens: int = Field(ge=0)
    ref_id: int = Field(default=0, ge=0)
    kind: str = ""
    role: str = ""
    importance: float = Field(default=0.0, ge=0, le=1)


class MemoryContextSection(BaseModel):
    """注入预览的一段（与 §6.4 的六层一一对应）。"""

    name: str
    title: str
    budget_tokens: int = Field(ge=0)
    used_tokens: int = Field(ge=0)
    dropped: bool = False
    items: list[MemoryContextItem]


class MemoryContextResponse(BaseModel):
    """「下一轮真的会塞给模型的那份记忆」的干跑结果（不调模型、不 mark_used）。"""

    char_id: str
    query: str
    empty: bool
    total_tokens: int = Field(ge=0)
    budget_tokens: int = Field(ge=0)
    dropped: list[str]
    injected_ids: list[int]
    sections: list[MemoryContextSection]
    text: str


class UsageRecordRequest(BaseModel):
    """主进程上报的一条使用事实（T2.3-C1/C2c）；char_id 由主进程带上，免得串角色。

    `window_shake` 只用 char_id；`char_hit` 还带 region_id（部位 id）、gesture（手势）与
    count（这一串几下：tap/pat 是次数，stroke/hold/knead 记 1）。
    两种事实都只记计数，不含任何文本内容（§6.9：只记事实，不记内容）。
    """

    fact: Literal["window_shake", "char_hit"]
    char_id: str = ""
    region_id: str = ""
    gesture: str = Field(default="tap", max_length=16)
    count: int = Field(default=0, ge=0)


class UsageRecordResponse(BaseModel):
    """recorded=false 表示没有可承接的会话或记录开关关着——这不是错误。"""

    recorded: bool


class UsageCharacterStat(BaseModel):
    char_id: str
    total_duration_sec: float = Field(ge=0)
    session_count: int = Field(ge=0)


class UsageStatsResponse(BaseModel):
    """F10 统计页只读汇总；token 字段来自模型服务，没上报时为 0。"""

    recording_enabled: bool
    total_sessions: int = Field(ge=0)
    total_messages: int = Field(ge=0)
    total_duration_sec: float = Field(ge=0)
    today_sessions: int = Field(ge=0)
    today_messages: int = Field(ge=0)
    today_duration_sec: float = Field(ge=0)
    llm_calls: int = Field(ge=0)
    prompt_tokens: int = Field(ge=0)
    cached_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    max_prompt_tokens: int = Field(ge=0)
    memory_tokens: int = Field(ge=0)
    characters: list[UsageCharacterStat] = Field(default_factory=list)


class UsageRecordingRequest(BaseModel):
    enabled: bool


class PresenceRequest(BaseModel):
    """主进程上报的在场快照；用于 F9 状态事实与 F5 主动决策。"""

    char_id: str = Field(min_length=1, max_length=64)
    session_id: str = ""
    window_visible: bool = True
    window_minimized: bool = False
    window_focused: bool = False
    idle_seconds: float = Field(default=0.0, ge=0)
    input_mode: str = "text"
    turn_active: bool = False
    quiet_hours: bool = False
    screen_changed: bool = False
    screen_text: str = Field(default="", max_length=4000)
    mic_busy: bool = False


class PresenceResponse(BaseModel):
    """主动决策；speak=false 时 kind / reason 只用于日志。"""

    proactive: bool = False
    kind: str = ""
    reason: str = ""


class ScreenCaptureRequest(BaseModel):
    """主进程抓到的屏幕帧；base64 JPEG，只在内存里流转。"""

    image_base64: str = Field(min_length=1, max_length=20_000_000)
    app_title: str = Field(default="", max_length=200)
    model: str = Field(default="", max_length=200)
    captured_at: str = ""


class ScreenOcrRequest(BaseModel):
    image_base64: str
    app_title: str = ""
    captured_at: str | None = None


class ScreenOcrResponse(BaseModel):
    text: str
    confidence: float = Field(ge=0, le=1)
    engine: str
    elapsed_ms: int = Field(ge=0)


class ScreenCaptureResponse(BaseModel):
    """屏幕识别结果；原文只在内存里流转，不落盘（需求 §7.3）。"""

    ocr_text: str
    confidence: float = Field(ge=0, le=1)
    captured_at: str
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    summary: str = ""
    interesting: bool = False
    vision_model: str = ""
    app_title: str = ""


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
