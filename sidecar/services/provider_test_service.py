"""文件职责：「测试连接」的用例编排（需求 §6.13 / T1.14b）。

边界：本模块只编排「探测哪些候选、怎么把结论翻成契约」，真正出网的三条路在
adapters/provider_probe.py（注入进来，测试可换假实现）。它**不读也不回 api_key**——
settings.llm.endpoint_specs() 里带着密钥，但只把它交给探测函数，不进任何契约字段。

为什么 ASR / TTS 云端要显式报错：T1.14 只做了 LLM 双轨，ASR / TTS 的云端实现后置（§6.13）。
按钮必须直说「尚未实现 + 怎么改回去」，而不是静默给个绿点（D14 / §6.7 的态度）。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from pydantic import SecretStr

from adapters.provider_probe import (
    ModelListOutcome,
    ProbeOutcome,
    list_llm_models,
    probe_asr_cloud,
    probe_asr_local,
    probe_llm_endpoint,
    probe_tts_adapter,
    probe_tts_edge,
)
from config import PROVIDER_EDGE, PROVIDER_LOCAL, LlmSettings, Settings
from contracts.health import ProviderCapability
from contracts.providers import (
    ProviderModelsResponse,
    ProviderProbeResult,
    ProviderTestOverrides,
    ProviderTestResponse,
)

LlmProbe = Callable[..., Awaitable[ProbeOutcome]]
ModelsLister = Callable[..., Awaitable[ModelListOutcome]]
TtsProbe = Callable[[str, str], Awaitable[ProbeOutcome]]
AsrProbe = Callable[[str, Path], ProbeOutcome]
AsrCloudProbe = Callable[[str, str, str], Awaitable[ProbeOutcome]]
TtsEdgeProbe = Callable[[str], ProbeOutcome]

#: 没配端点时给出可执行的下一步，而不是一句「失败」。
HINT_NO_LLM_ENDPOINT = (
    "没有可用的 LLM 端点：请在设置里填云端 base_url / model，"
    "或填本地 base_url / model 并把 provider 切到 local"
)
HINT_NO_ASR_ENDPOINT = "云端识别没配端点：请填云端 base_url / model / api_key，或把来源改回本地"
HINT_CLOUD_TTS = "云端语音合成尚未实现，请把来源改成 edge（Edge 在线）或 local（自己部署的适配器）"


def _text_override(current: str, value: str | None) -> str:
    """None = 沿用已保存值；空串 = 这次真的清空。"""
    return current if value is None else value


def _secret_override(current: str, value: SecretStr | None) -> str:
    """SecretStr 只在本次探测里解出明文；不写日志、不进结果。"""
    return current if value is None else value.get_secret_value()


class ProviderTestService:
    """按能力面探测供给端点；构造时注入 settings 与三个探测函数（默认走真实适配器）。"""

    def __init__(
        self,
        settings: Settings,
        *,
        llm_probe: LlmProbe = probe_llm_endpoint,
        tts_probe: TtsProbe = probe_tts_adapter,
        asr_probe: AsrProbe = probe_asr_local,
        asr_cloud_probe: AsrCloudProbe = probe_asr_cloud,
        tts_edge_probe: TtsEdgeProbe = probe_tts_edge,
        models_lister: ModelsLister = list_llm_models,
    ) -> None:
        self._settings = settings
        self._llm_probe = llm_probe
        self._tts_probe = tts_probe
        self._asr_probe = asr_probe
        self._asr_cloud_probe = asr_cloud_probe
        self._tts_edge_probe = tts_edge_probe
        self._models_lister = models_lister

    async def test(
        self,
        capability: ProviderCapability,
        overrides: ProviderTestOverrides | None = None,
    ) -> ProviderTestResponse:
        """探测一个能力面；调用方（api/providers.py）已完成入参校验。"""
        if capability == "llm":
            results = await self._test_llm(overrides)
        elif capability == "asr":
            results = [await self._test_asr(overrides)]
        else:
            results = [await self._test_tts(overrides)]
        return ProviderTestResponse(capability=capability, results=results)

    async def list_models(
        self,
        capability: ProviderCapability,
        overrides: ProviderTestOverrides | None = None,
    ) -> ProviderModelsResponse:
        """拉取 LLM 云端端点的 /models；ASR / TTS 暂不提供模型列表。"""
        if capability != "llm":
            return ProviderModelsResponse(
                capability=capability,
                detail="语音识别 / 合成端点暂不支持获取模型列表。",
            )
        llm = self._effective_llm(overrides)
        specs = llm.endpoint_specs()
        if overrides is not None and overrides.provider is not None:
            specs = tuple(spec for spec in specs if spec[3] == overrides.provider)
        if not specs:
            return ProviderModelsResponse(
                capability=capability,
                detail="没有可用的对话模型端点：先填云端端点与密钥。",
            )
        base_url, api_key, _model, provider = specs[0]
        preset = llm.preset if provider != PROVIDER_LOCAL else ""
        outcome = await self._models_lister(base_url, api_key, preset=preset)
        return ProviderModelsResponse(
            capability=capability,
            models=list(outcome.models),
            detail=outcome.detail,
        )

    def _effective_llm(self, overrides: ProviderTestOverrides | None) -> LlmSettings:
        llm = self._settings.llm
        if overrides is None:
            return llm
        return replace(
            llm,
            provider=overrides.provider or llm.provider,
            preset=_text_override(llm.preset, overrides.preset),
            base_url=_text_override(llm.base_url, overrides.cloud_base_url),
            model=_text_override(llm.model, overrides.cloud_model),
            api_key=_secret_override(llm.api_key, overrides.cloud_api_key),
            local_base_url=_text_override(llm.local_base_url, overrides.local_base_url),
            local_model=_text_override(llm.local_model, overrides.local_model),
            fallback_base_url=_text_override(llm.fallback_base_url, overrides.fallback_base_url),
            fallback_model=_text_override(llm.fallback_model, overrides.fallback_model),
        )

    async def _test_llm(
        self, overrides: ProviderTestOverrides | None = None
    ) -> list[ProviderProbeResult]:
        """逐候选探测 LLM 端点：顺序与真实请求一致（主用 → 备用 → 另一供给）。"""
        llm = self._effective_llm(overrides)
        specs = llm.endpoint_specs()
        # 设置窗明确选了来源时只测这一面；旧脚本/无 overrides 仍按完整候选顺序对账。
        if overrides is not None and overrides.provider is not None:
            specs = tuple(spec for spec in specs if spec[3] == overrides.provider)
        if not specs:
            return [
                ProviderProbeResult(
                    provider=llm.provider,
                    ok=False,
                    detail=HINT_NO_LLM_ENDPOINT,
                    elapsed_ms=0,
                )
            ]
        results: list[ProviderProbeResult] = []
        for base_url, api_key, model, provider in specs:
            preset = llm.preset if provider != PROVIDER_LOCAL else ""
            outcome = await self._llm_probe(base_url, api_key, model, preset=preset)
            results.append(
                ProviderProbeResult(
                    provider=provider,
                    base_url=base_url,
                    model=model,
                    ok=outcome.ok,
                    detail=outcome.detail,
                    elapsed_ms=outcome.elapsed_ms,
                )
            )
        return results

    async def _test_asr(
        self, overrides: ProviderTestOverrides | None = None
    ) -> ProviderProbeResult:
        """ASR：本地探模型是否落地，云端探转录端点连通性（T2.4）。"""
        asr = self._settings.asr
        if overrides is not None:
            asr = replace(
                asr,
                provider=overrides.provider or asr.provider,
                preset=_text_override(asr.preset, overrides.preset),
                cloud_base_url=_text_override(asr.cloud_base_url, overrides.cloud_base_url),
                cloud_model=_text_override(asr.cloud_model, overrides.cloud_model),
                cloud_api_key=_secret_override(asr.cloud_api_key, overrides.cloud_api_key),
                model=_text_override(asr.model, overrides.local_model),
            )
        provider = asr.provider
        if provider == PROVIDER_LOCAL:
            outcome = self._asr_probe(asr.model, asr.model_dir)
            return ProviderProbeResult(
                provider=provider,
                model=asr.model,
                ok=outcome.ok,
                detail=outcome.detail,
                elapsed_ms=outcome.elapsed_ms,
            )
        if not asr.cloud_base_url:
            return ProviderProbeResult(
                provider=provider, ok=False, detail=HINT_NO_ASR_ENDPOINT, elapsed_ms=0
            )
        outcome = await self._asr_cloud_probe(
            asr.cloud_base_url, asr.cloud_api_key, asr.cloud_model
        )
        return ProviderProbeResult(
            provider=provider,
            base_url=asr.cloud_base_url,
            model=asr.cloud_model,
            ok=outcome.ok,
            detail=outcome.detail,
            elapsed_ms=outcome.elapsed_ms,
        )

    async def _test_tts(
        self, overrides: ProviderTestOverrides | None = None
    ) -> ProviderProbeResult:
        """TTS：本地适配器探 /health，edge 探库与音色名，cloud 仍未实现（§6.12 / T2.4）。"""
        tts = self._settings.tts
        if overrides is not None:
            tts = replace(
                tts,
                provider=overrides.provider or tts.provider,
                preset=_text_override(tts.preset, overrides.preset),
                base_url=_text_override(tts.base_url, overrides.local_base_url),
                token=_secret_override(tts.token, overrides.local_token),
            )
        provider = tts.provider
        if provider == PROVIDER_LOCAL:
            outcome = await self._tts_probe(tts.base_url, tts.token)
            return ProviderProbeResult(
                provider=provider,
                base_url=tts.base_url,
                ok=outcome.ok,
                detail=outcome.detail,
                elapsed_ms=outcome.elapsed_ms,
            )
        if provider == PROVIDER_EDGE:
            outcome = self._tts_edge_probe(tts.edge_voice)
            return ProviderProbeResult(
                provider=provider,
                model=tts.edge_voice,
                ok=outcome.ok,
                detail=outcome.detail,
                elapsed_ms=outcome.elapsed_ms,
            )
        return ProviderProbeResult(provider=provider, ok=False, detail=HINT_CLOUD_TTS, elapsed_ms=0)


def build_provider_test_service(settings: Settings) -> ProviderTestService:
    """组合根用的便捷构造（真实探测函数即默认值）。"""
    return ProviderTestService(settings)


__all__ = [
    "HINT_CLOUD_TTS",
    "HINT_NO_ASR_ENDPOINT",
    "HINT_NO_LLM_ENDPOINT",
    "ProviderTestService",
    "build_provider_test_service",
]
