"""文件职责：sidecar HTTP 路由清单（唯一事实来源，对应需求 §6.3）。

依赖方向：contracts 是最内层数据契约，任何层都可以 import 它；本模块只依赖标准库。
谁调用：sidecar/api/router.py 依据本表挂载路由；scripts/export_openapi.py 与
tests/test_api_contract.py 拿本表与实际挂载结果对账（防止契约漂移）。
"""

from dataclasses import dataclass
from typing import Literal

# 服务标识：写进 OpenAPI 的 info 段，也是 runtime.json 的 service 字段（需求 §6.3）
SERVICE_NAME = "deskpet-sidecar"
SERVICE_VERSION = "0.1.0"

HttpMethod = Literal["GET", "POST", "DELETE"]


@dataclass(frozen=True, slots=True)
class ApiRoute:
    """一条 HTTP 路由的契约描述。

    字段：
        method: HTTP 方法。
        path: 路径；路径参数用花括号，例如 /memory/{memory_id}。
        purpose: 中文用途，直接作为 OpenAPI 的 summary（需求 §6.3 表格原文）。
        error_domain: 失败时使用的错误域（CODE_STYLE §6.1）。
        path_params: 路径参数名，按出现顺序；实现该路由时必须与 path 对齐。
        m0_implemented: M0 是否已实现；False 表示当前由 api/stubs.py 返回 501。
    """

    method: HttpMethod
    path: str
    purpose: str
    error_domain: str
    path_params: tuple[str, ...] = ()
    m0_implemented: bool = False


API_ROUTES: tuple[ApiRoute, ...] = (
    ApiRoute(
        method="GET",
        path="/health",
        purpose="存活、模型加载状态、显存占用",
        error_domain="SYS",
        m0_implemented=True,
    ),
    ApiRoute(
        method="POST",
        path="/asr",
        purpose="原始 PCM（不依赖 ffmpeg）→ 文本 + 置信度",
        error_domain="ASR",
    ),
    ApiRoute(
        method="POST",
        path="/tts",
        purpose="文本 + 情感向量 → 音频流",
        error_domain="TTS",
    ),
    ApiRoute(
        method="POST",
        path="/tts/cancel",
        purpose="按 request_id 取消未完成的合成",
        error_domain="TTS",
    ),
    ApiRoute(
        method="POST",
        path="/chat/stream",
        purpose="会话主入口：SSE 返回 LLM 事件流",
        error_domain="LLM",
    ),
    ApiRoute(
        method="GET",
        path="/memory/search",
        purpose="记忆检索：全文 + 重要度 + 时间衰减",
        error_domain="MEM",
    ),
    ApiRoute(
        method="POST",
        path="/memory/write",
        purpose="写入记忆（带去重）",
        error_domain="MEM",
    ),
    ApiRoute(
        method="DELETE",
        path="/memory/{memory_id}",
        purpose="单条删除（隐私：让用户能要求忘掉某件事）",
        error_domain="MEM",
        path_params=("memory_id",),
    ),
    ApiRoute(
        method="POST",
        path="/screen/capture",
        purpose="热键触发截屏 + OCR，返回文本且不落盘",
        error_domain="SCR",
    ),
    ApiRoute(
        method="POST",
        path="/persona/import",
        purpose="导入自有角色包（目录或单个 .zip）→ 体检 + 落地 characters/",
        error_domain="PACK",
    ),
    ApiRoute(
        method="POST",
        path="/gpu/lock",
        purpose="重型推理串行排队（当前仅 TTS）",
        error_domain="SYS",
    ),
)

# M0 真正实现的路由（其余都是 501 桩）；契约测试用它对账
M0_IMPLEMENTED_ROUTES: frozenset[tuple[str, str]] = frozenset(
    (route.method, route.path) for route in API_ROUTES if route.m0_implemented
)
