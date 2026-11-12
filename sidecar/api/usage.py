"""文件职责：使用事实上报路由（T2.3-C1，需求 §6.3 / §6.9）——窗口晃动等主进程可见的事实。

依赖方向：api -> services（仅注入）+ contracts；不 import adapters。
谁调用：sidecar/api/router.py 构建路由时调用 build_usage_router()。
约定：
- 这些事实只有主进程看得见（窗口位移、立绘命中），sidecar 只负责记账，不做判断。
- 记账失败不抛异常，只回 recorded=false：统计是增强项，绝不能反过来打扰界面（§6.7）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from contracts.api_models import (
    UsageCharacterStat,
    UsageRecordingRequest,
    UsageRecordRequest,
    UsageRecordResponse,
    UsageStatsResponse,
)
from contracts.errors import ErrorEnvelope
from core.usage import UsageOverview
from services.usage_service import UsageService

#: 401 也要写进 OpenAPI（本机回环也要带 token，§6.10）
_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {401: {"model": ErrorEnvelope}}


def _stats_response(overview: UsageOverview) -> UsageStatsResponse:
    """把 core.UsageOverview 转成 API 模型；字段名保持 snake_case。"""
    return UsageStatsResponse(
        recording_enabled=overview.recording_enabled,
        total_sessions=overview.total_sessions,
        total_messages=overview.total_messages,
        total_duration_sec=overview.total_duration_sec,
        today_sessions=overview.today_sessions,
        today_messages=overview.today_messages,
        today_duration_sec=overview.today_duration_sec,
        llm_calls=overview.llm_calls,
        prompt_tokens=overview.prompt_tokens,
        cached_tokens=overview.cached_tokens,
        completion_tokens=overview.completion_tokens,
        total_tokens=overview.total_tokens,
        max_prompt_tokens=overview.max_prompt_tokens,
        memory_tokens=overview.memory_tokens,
        characters=[
            UsageCharacterStat(
                char_id=item.char_id,
                total_duration_sec=item.total_duration_sec,
                session_count=item.session_count,
            )
            for item in overview.characters
        ],
    )


def build_usage_router(service: UsageService) -> APIRouter:
    """把使用事实上报挂成真实现（T2.3）；桩表里没有它，所以不用改 api/stubs.py。"""
    router = APIRouter(tags=["usage"])

    @router.post(
        "/usage/record",
        summary="记录主进程发现的使用事实（窗口晃动 / 立绘部位点击）",
        response_model=UsageRecordResponse,
        responses=_ERROR_RESPONSES,
    )
    async def record(payload: UsageRecordRequest) -> UsageRecordResponse:
        """按 fact 分派；两种事实都只记计数，不落任何文本内容（§6.9）。"""
        if payload.fact == "char_hit":
            recorded = service.record_char_hit(
                payload.char_id,
                payload.region_id,
                gesture=payload.gesture,
                count=max(1, payload.count),
            )
        else:
            recorded = service.record_window_shake(payload.char_id)
        return UsageRecordResponse(recorded=recorded)

    @router.get(
        "/usage/stats",
        summary="读取使用统计（F10）",
        response_model=UsageStatsResponse,
        responses=_ERROR_RESPONSES,
    )
    async def stats() -> UsageStatsResponse:
        await service.flush()
        return _stats_response(service.overview())

    @router.post(
        "/usage/recording",
        summary="暂停 / 恢复使用统计记录",
        response_model=UsageStatsResponse,
        responses=_ERROR_RESPONSES,
    )
    async def recording(payload: UsageRecordingRequest) -> UsageStatsResponse:
        await service.set_enabled(payload.enabled)
        return _stats_response(service.overview())

    @router.delete(
        "/usage",
        summary="清空使用统计（保留记录开关）",
        response_model=UsageStatsResponse,
        responses=_ERROR_RESPONSES,
    )
    async def clear() -> UsageStatsResponse:
        await service.clear()
        return _stats_response(service.overview())

    return router
