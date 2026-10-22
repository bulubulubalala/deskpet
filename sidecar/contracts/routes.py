"""文件职责：sidecar HTTP 路由清单（唯一事实来源，对应需求 §6.3）。

依赖方向：contracts 是最内层数据契约，任何层都可以 import 它；本模块只依赖标准库。
谁调用：sidecar/api/router.py 依据本表挂载路由；scripts/export_openapi.py 与
tests/test_api_contract.py 拿本表与实际挂载结果对账（防止契约漂移）。

T1.1 起本表同时描述**模型级契约**：query 参数模型、请求体模型与媒体类型、200 响应模型与
媒体类型。api/stubs.py 必须照本表把声明挂到路由上，契约测试逐条比对 OpenAPI——两边不一致
就红。字段留空表示该路由的模型尚未细化（M2/M4 实现时再补），不是「没有契约」。
"""

from dataclasses import dataclass
from typing import Literal

# 服务标识：写进 OpenAPI 的 info 段，也是 runtime.json 的 service 字段（需求 §6.3）
SERVICE_NAME = "deskpet-sidecar"
SERVICE_VERSION = "0.1.0"

#: 语音全双工的 WebSocket 端点（P2）。它不在 HTTP 路由表 API_ROUTES 里（OpenAPI 不描述 WS），
#: 由 api/voice_ws.py 单独挂载；主进程 app/main/voice-socket.ts 是唯一客户端。
VOICE_WS_PATH = "/ws/voice"

HttpMethod = Literal["GET", "POST", "DELETE", "PATCH"]

# 契约里出现的三种媒体类型：JSON、原始 PCM（F2 要求不依赖 ffmpeg）、TTS 音频流、
# SSE 事件流（§6.2 的逐行 JSON）。定义在这里是为了让路由表自身就能完整描述契约。
JSON_MEDIA_TYPE = "application/json"
PCM_MEDIA_TYPE = "application/octet-stream"
TTS_MEDIA_TYPE = "audio/wav"
#: 云端 TTS（edge-tts）回的是 MP3；/tts 的 200 媒体类型随 provider 变，两种都登记进
#: OpenAPI（T2.4）。
TTS_MP3_MEDIA_TYPE = "audio/mpeg"
SSE_MEDIA_TYPE = "text/event-stream"


@dataclass(frozen=True, slots=True)
class ApiRoute:
    """一条 HTTP 路由的契约描述。

    字段：
        method: HTTP 方法。
        path: 路径；路径参数用花括号，例如 /memory/{memory_id}。
        purpose: 中文用途，直接作为 OpenAPI 的 summary（需求 §6.3 表格原文）。
        error_domain: 失败时使用的错误域（CODE_STYLE §6.4）。
        path_params: 路径参数名，按出现顺序；实现该路由时必须与 path 对齐。
        implemented: 是否已实现；False 表示当前由 api/stubs.py 返回 501。
        query_model: query 参数模型的 schema 名（§6.3 里 GET / POST 都可能有）。
        request_model: 请求体模型的 schema 名；None 表示没有 JSON 请求体。
        request_media_type: 请求体媒体类型；None 表示 JSON（当 request_model 有值时）。
        response_model: 200 响应模型的 schema 名；None 表示不是 JSON 响应。
        response_media_type: 200 响应媒体类型；None 表示 JSON（当 response_model 有值时）。
    """

    method: HttpMethod
    path: str
    purpose: str
    error_domain: str
    path_params: tuple[str, ...] = ()
    implemented: bool = False
    query_model: str | None = None
    request_model: str | None = None
    request_media_type: str | None = None
    response_model: str | None = None
    response_media_type: str | None = None


API_ROUTES: tuple[ApiRoute, ...] = (
    ApiRoute(
        method="GET",
        path="/health",
        purpose="存活、模型加载状态、显存占用",
        error_domain="SYS",
        implemented=True,
        response_model="HealthResponse",
    ),
    ApiRoute(
        method="POST",
        path="/asr",
        purpose="原始 PCM（不依赖 ffmpeg）→ 文本 + 置信度",
        error_domain="ASR",
        implemented=True,
        query_model="AsrQuery",
        request_media_type=PCM_MEDIA_TYPE,
        response_model="AsrResponse",
    ),
    ApiRoute(
        method="POST",
        path="/tts",
        purpose="文本 + 情感向量 → 音频流",
        error_domain="TTS",
        implemented=True,
        request_model="TtsRequest",
        response_media_type=TTS_MEDIA_TYPE,
    ),
    ApiRoute(
        method="POST",
        path="/tts/cancel",
        purpose="按 request_id 取消未完成的合成",
        error_domain="TTS",
        implemented=True,
        request_model="TtsCancelRequest",
        response_model="TtsCancelResponse",
    ),
    ApiRoute(
        method="POST",
        path="/chat/stream",
        purpose="会话主入口：SSE 返回 LLM 事件流",
        error_domain="LLM",
        implemented=True,
        request_model="ChatStreamRequest",
        response_media_type=SSE_MEDIA_TYPE,
    ),
    ApiRoute(
        method="POST",
        path="/providers/test",
        purpose="按能力面探测供给端点连通性（只回结论，绝不回密钥）",
        error_domain="SYS",
        implemented=True,
        request_model="ProviderTestRequest",
        response_model="ProviderTestResponse",
    ),
    ApiRoute(
        method="GET",
        path="/memory/search",
        purpose="记忆检索：全文 + 重要度 + 时间衰减",
        error_domain="MEM",
        implemented=True,
        query_model="MemorySearchQuery",
        response_model="MemorySearchResponse",
    ),
    ApiRoute(
        method="POST",
        path="/memory/write",
        purpose="写入记忆（带去重）",
        error_domain="MEM",
        implemented=True,
        request_model="MemoryWriteRequest",
        response_model="MemoryWriteResponse",
    ),
    ApiRoute(
        method="DELETE",
        path="/memory/{memory_id}",
        purpose="单条删除（隐私：让用户能要求忘掉某件事）",
        error_domain="MEM",
        implemented=True,
        path_params=("memory_id",),
        response_model="MemoryDeleteResponse",
    ),
    ApiRoute(
        method="GET",
        path="/memory/list",
        purpose="列出一个角色的记忆（管理界面用）",
        error_domain="MEM",
        implemented=True,
        query_model="MemoryListQuery",
        response_model="MemoryListResponse",
    ),
    ApiRoute(
        method="PATCH",
        path="/memory/{memory_id}",
        purpose="改一条 L0 记忆的文本与重要度（开发者模式：只动 memories 表）",
        error_domain="MEM",
        implemented=True,
        path_params=("memory_id",),
        request_model="MemoryEditRequest",
        response_model="MemoryEditResponse",
    ),
    ApiRoute(
        method="POST",
        path="/memory/clear",
        purpose="清空一个角色的记忆（可选只清更早的）",
        error_domain="MEM",
        implemented=True,
        request_model="MemoryClearRequest",
        response_model="MemoryClearResponse",
    ),
    ApiRoute(
        method="GET",
        path="/memory/messages",
        purpose="开发者模式「原文」页：按 id 倒序翻历史原文（只读）",
        error_domain="MEM",
        implemented=True,
        query_model="MemoryMessagesQuery",
        response_model="MemoryMessagesResponse",
    ),
    ApiRoute(
        method="GET",
        path="/memory/context",
        purpose="开发者模式「注入上下文」页：干跑一次下一轮的记忆装配（不调模型）",
        error_domain="MEM",
        implemented=True,
        query_model="MemoryContextQuery",
        response_model="MemoryContextResponse",
    ),
    ApiRoute(
        method="POST",
        path="/usage/record",
        purpose="记录主进程发现的使用事实（窗口晃动 / 立绘部位点击）",
        error_domain="SYS",
        implemented=True,
        request_model="UsageRecordRequest",
        response_model="UsageRecordResponse",
    ),
    ApiRoute(
        method="POST",
        path="/screen/capture",
        purpose="热键触发截屏 + OCR，返回文本且不落盘",
        error_domain="SCR",
        implemented=True,
        request_model="ScreenCaptureRequest",
        response_model="ScreenCaptureResponse",
    ),
    ApiRoute(
        method="POST",
        path="/persona/import",
        purpose="导入自有角色包（目录或单个 .zip）→ 体检 + 落地 characters/",
        error_domain="PACK",
    ),
)

# 真正实现的路由（其余都是 501 桩）；契约测试用它对账：任何声明为已实现的路由，
# 都必须能找到对应的真实处理器，且不再出现在桩代码里。
IMPLEMENTED_ROUTES: frozenset[tuple[str, str]] = frozenset(
    (route.method, route.path) for route in API_ROUTES if route.implemented
)
