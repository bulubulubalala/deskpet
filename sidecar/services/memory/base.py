"""文件职责：记忆用例层的公共底座：依赖、降级、错误翻译、/health 汇报、三方协作注入。

依赖方向：services -> adapters / core / contracts（库与密钥由组合根注入）；不 import api。
谁调用：services/memory/ 下各域 mixin 继承本类，services.memory.MemoryService 汇总。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import replace

from config import MemorySettings
from contracts.errors import (
    CODE_MEM_INDEX_BROKEN,
    CODE_MEM_KEY_INVALID,
    CODE_MEM_READONLY_FALLBACK,
)
from contracts.health import ModuleState
from core.env_events import EVENT_MEM_KEY_INVALID, EVENT_MEM_READONLY, EnvEventReporter
from core.errors import MemoryStoreError
from core.logging import get_logger, log_event
from core.memory import (
    MemoryBackendError,
    MemoryDraft,
    MemoryIndexBrokenError,
    MemoryKeyInvalidError,
    MemoryReadonlyError,
    MemoryStore,
)
from services.recall_builder import RecallTuning

LOGGER = get_logger("services.memory_service")

#: 模块不可用时给 /health 的 detail（机器可读短描述，§6.3）
_DETAIL_BY_ERROR: dict[type[MemoryBackendError], str] = {
    MemoryKeyInvalidError: "key_invalid",
    MemoryReadonlyError: "readonly",
    MemoryIndexBrokenError: "index_broken",
}


class MemoryServiceBase:
    """记忆用例层的公共底座。

    store=None 表示「启动时就没能打开记忆库」（密钥失效 / 目录只读）：此时对话链路
    照常跑，只是永远没有记忆可用——这是 §6.4 要求的降级行为，不是错误。
    """

    def __init__(
        self,
        store: MemoryStore | None,
        settings: MemorySettings,
        *,
        env: EnvEventReporter | None = None,
        startup_error: MemoryBackendError | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._env = env
        self._startup_error = startup_error
        # 运行期出现过结构性故障（密钥/只读/索引）也记下来，让 /health 的模块态别再谎报 ready
        self._fault: MemoryBackendError | None = startup_error
        self._now = now or time.time
        self._timeline: object | None = None
        self._graph: object | None = None
        self._embedding: object | None = None
        self._tuning = RecallTuning()
        if startup_error is not None:
            self._degrade(startup_error, action="startup")

    @property
    def available(self) -> bool:
        """记忆库当前可用吗（不可用时对话链路不记不读）。"""
        return self._store is not None

    @property
    def store(self) -> MemoryStore | None:
        """底层记忆库（None = 打不开）；阶梯压缩（T2.1b）要用它读写摘要与未覆盖原文。"""
        return self._store

    @property
    def startup_error(self) -> MemoryBackendError | None:
        """启动时打开记忆库失败的原始异常（None = 正常）；管理端点据此给错误码。"""
        return self._startup_error

    def module_state(self) -> tuple[ModuleState, str | None]:
        """给 /health 的模块状态：可用=ready，打不开或出过结构性故障=error + 机器可读原因。"""
        fault = self._fault
        if self._store is not None and fault is None:
            return ModuleState.READY, None
        if fault is None:
            return ModuleState.ERROR, "unavailable"
        return ModuleState.ERROR, _DETAIL_BY_ERROR.get(type(fault), "unavailable")

    def attach_embedding(
        self,
        embedding: object | None,
        *,
        model: str = "",
        min_similarity: float = 0.0,
        fts_weight: float = 0.35,
        vector_weight: float = 0.65,
    ) -> None:
        """注入语义检索服务；不注入时完全保持原来的 FTS 行为。"""
        self._embedding = embedding
        self._tuning = RecallTuning(
            model=model,
            min_score=min_similarity,
            fts_weight=fts_weight,
            vector_weight=vector_weight,
        )

    def attach_timeline(self, timeline: object | None) -> None:
        """注入时间线生成服务；不注入时管理端点只能读已有时间桶。"""
        self._timeline = timeline

    def attach_graph(self, graph: object | None) -> None:
        """注入知识图谱抽取服务。"""
        self._graph = graph

    def _require_store(self) -> MemoryStore:
        """管理端点用：不可用就把启动时的失败原因抛成 DP-MEM-*。"""
        if self._store is not None:
            return self._store
        raise self._domain_error(self._startup_error or MemoryBackendError("记忆库不可用"))

    def _degrade(self, exc: MemoryBackendError, *, action: str) -> None:
        """对话链路的统一降级：记日志 + 上报环境事件，绝不外抛。"""
        if self._fault is None:
            self._fault = exc
        log_event(
            LOGGER,
            logging.WARNING,
            module="services.memory_service",
            event="memory.degraded",
            message="记忆不可用，本轮按「没有记忆」处理",
            fields={"action": action, "reason": type(exc).__name__, "error": str(exc)},
        )
        self._report_event(exc)

    def _degrade_embedding(self, exc: Exception) -> None:
        """语义索引失败时的降级钩子（实现在 EmbeddingMixin，这里只是让类型检查认识它）。"""
        raise NotImplementedError

    def _report_event(self, exc: MemoryBackendError) -> None:
        """事实进 fact、用户提示进 user_hint（§6.8）；只有密钥失效与只读降级有事件码。"""
        if self._env is None:
            return
        if isinstance(exc, MemoryKeyInvalidError):
            self._env.report(
                EVENT_MEM_KEY_INVALID,
                fact="记忆库密钥不可用（读不出或与当前库不匹配）",
                user_hint="记忆暂时读不出来，可在设置里重置记忆库后重新开始。",
            )
        elif isinstance(exc, MemoryReadonlyError):
            self._env.report(
                EVENT_MEM_READONLY,
                fact="记忆库不可写（数据目录只读或被占用）",
                user_hint="这轮对话暂时不会被记住。",
            )

    def _domain_error(self, exc: MemoryBackendError) -> MemoryStoreError:
        """把适配器异常翻译成带错误码与用户指引的 DP-MEM-*（§6.5）。"""
        if isinstance(exc, MemoryKeyInvalidError):
            return MemoryStoreError(
                CODE_MEM_KEY_INVALID,
                str(exc),
                user_hint=(
                    "记忆库的密钥读不出来（换过 Windows 用户或换过机器？）。"
                    "重置记忆库可以重新开始。"
                ),
            )
        if isinstance(exc, MemoryReadonlyError):
            return MemoryStoreError(
                CODE_MEM_READONLY_FALLBACK,
                str(exc),
                user_hint="记忆库文件不可写，检查数据目录权限或占用后再试。",
            )
        return MemoryStoreError(
            CODE_MEM_INDEX_BROKEN,
            str(exc),
            user_hint="记忆库的全文索引坏了，可以清空这个角色的记忆后重试。",
        )

    def _with_defaults(self, draft: MemoryDraft, *, char_id: str, ts: float) -> MemoryDraft:
        """补 LLM 没给的字段：角色 id 与发生时间（缺了就按这一轮的时间算）。"""
        patched = draft
        if not patched.char_id:
            patched = replace(patched, char_id=char_id)
        if patched.occurred_at is None:
            patched = replace(patched, occurred_at=ts)
        return patched
