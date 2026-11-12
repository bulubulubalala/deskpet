"""文件职责：单测 services/provider_test_service.py 的编排与措辞（§6.13 / T1.14b）。

为什么单列：探测函数本身在 test_provider_probe.py 里用 MockTransport 验；这里验的是
「探哪些候选、顺序对不对、密钥会不会漏进契约、云端后置怎么提示」——全部用假探测函数，
不联网（§6.7：单测必须无网络无硬件可跑）。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

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
from app import create_app
from config import load_settings
from contracts.providers import ProviderTestOverrides, ProviderTestResponse
from services.provider_test_service import (
    HINT_CLOUD_TTS,
    HINT_NO_ASR_ENDPOINT,
    HINT_NO_LLM_ENDPOINT,
    AsrCloudProbe,
    AsrProbe,
    LlmProbe,
    ProviderTestService,
    TtsEdgeProbe,
    TtsProbe,
)

SECRET = "sk-secret-value"

CLOUD_AND_LOCAL_ENV = {
    "DESKPET_LLM_PROVIDER": "cloud",
    "DESKPET_LLM_BASE_URL": "https://cloud.example.com/v1",
    "DESKPET_LLM_API_KEY": SECRET,
    "DESKPET_LLM_MODEL": "cloud-model",
    "DESKPET_LLM_FALLBACK_BASE_URL": "https://backup.example.com/v1",
    "DESKPET_LLM_FALLBACK_MODEL": "backup-model",
    "DESKPET_LLM_LOCAL_BASE_URL": "http://127.0.0.1:11434/v1",
    "DESKPET_LLM_LOCAL_MODEL": "local-model",
}


class RecordingLlmProbe:
    """假的 LLM 探测：记录每次调用的 (base_url, api_key, model)，返回固定结论。"""

    def __init__(self, outcome: ProbeOutcome | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.presets: list[str] = []
        self._outcome = outcome or ProbeOutcome(True, "HTTP 200，OpenAI 兼容响应", 7)

    async def __call__(
        self, base_url: str, api_key: str, model: str, preset: str = ""
    ) -> ProbeOutcome:
        self.calls.append((base_url, api_key, model))
        self.presets.append(preset)
        return self._outcome


class RecordingTtsProbe:
    """假的 TTS 探测：记录 (base_url, token)。"""

    def __init__(self, outcome: ProbeOutcome | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self._outcome = outcome or ProbeOutcome(True, "适配器在线，模型尚未加载", 3)

    async def __call__(self, base_url: str, token: str) -> ProbeOutcome:
        self.calls.append((base_url, token))
        return self._outcome


class RecordingAsrProbe:
    """假的本地识别探测：记录 (model, model_dir)。"""

    def __init__(self, outcome: ProbeOutcome | None = None) -> None:
        self.calls: list[tuple[str, Path]] = []
        self._outcome = outcome or ProbeOutcome(True, "本地模型已就位", 1)

    def __call__(self, model: str, model_dir: Path) -> ProbeOutcome:
        self.calls.append((model, model_dir))
        return self._outcome


class RecordingAsrCloudProbe:
    """假的云端识别探测：记录 (base_url, api_key, model)。"""

    def __init__(self, outcome: ProbeOutcome | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self._outcome = outcome or ProbeOutcome(True, "HTTP 200，转录端点可用", 12)

    async def __call__(self, base_url: str, api_key: str, model: str) -> ProbeOutcome:
        self.calls.append((base_url, api_key, model))
        return self._outcome


class RecordingTtsEdgeProbe:
    """假的 edge 探测：记录音色名。"""

    def __init__(self, outcome: ProbeOutcome | None = None) -> None:
        self.calls: list[str] = []
        self._outcome = outcome or ProbeOutcome(True, "edge-tts 已安装", 2)

    def __call__(self, voice: str) -> ProbeOutcome:
        self.calls.append(voice)
        return self._outcome


def _service(
    env: dict[str, str],
    *,
    llm_probe: LlmProbe = probe_llm_endpoint,
    tts_probe: TtsProbe = probe_tts_adapter,
    asr_probe: AsrProbe = probe_asr_local,
    asr_cloud_probe: AsrCloudProbe = probe_asr_cloud,
    tts_edge_probe: TtsEdgeProbe = probe_tts_edge,
    models_lister: object = list_llm_models,
) -> ProviderTestService:
    """统一构造：默认用真实探测函数，测试点名的那个换成假实现（其余路径不会被走到）。"""
    return ProviderTestService(
        load_settings(env=env),
        llm_probe=llm_probe,
        tts_probe=tts_probe,
        asr_probe=asr_probe,
        asr_cloud_probe=asr_cloud_probe,
        tts_edge_probe=tts_edge_probe,
        models_lister=models_lister,  # type: ignore[arg-type]
    )


async def test_llm_probes_every_candidate_in_config_order() -> None:
    """LLM 面的候选顺序必须与真实请求一致：主用 → 显式备用 → 另一个供给。"""
    llm = RecordingLlmProbe()
    service = _service(CLOUD_AND_LOCAL_ENV, llm_probe=llm)

    response = await service.test("llm")

    assert [result.provider for result in response.results] == ["cloud", "fallback", "local"]
    assert [(url, model) for url, _, model in llm.calls] == [
        ("https://cloud.example.com/v1", "cloud-model"),
        ("https://backup.example.com/v1", "backup-model"),
        ("http://127.0.0.1:11434/v1", "local-model"),
    ]
    assert all(result.ok for result in response.results)
    assert response.results[0].elapsed_ms == 7


async def test_llm_test_only_probes_selected_provider() -> None:
    """设置窗明确选了云端就只测云端，不在后台顺手测本地/备用。"""
    llm = RecordingLlmProbe()
    service = _service(CLOUD_AND_LOCAL_ENV, llm_probe=llm)

    response = await service.test("llm", ProviderTestOverrides(provider="cloud"))

    assert [result.provider for result in response.results] == ["cloud"]
    assert [(url, model) for url, _, model in llm.calls] == [
        ("https://cloud.example.com/v1", "cloud-model")
    ]


async def test_list_models_uses_unsaved_values_and_preset() -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_lister(
        base_url: str, api_key: str, *, preset: str = ""
    ) -> ModelListOutcome:
        calls.append((base_url, api_key, preset))
        return ModelListOutcome(("m1", "m2"), "")

    service = _service(
        {
            "DESKPET_LLM_PROVIDER": "cloud",
            "DESKPET_LLM_BASE_URL": "https://old.example.com/v1",
            "DESKPET_LLM_MODEL": "old-model",
            "DESKPET_LLM_API_KEY": "old-key",
        },
        models_lister=fake_lister,
    )

    report = await service.list_models(
        "llm",
        ProviderTestOverrides(
            provider="cloud",
            preset="opencode-go",
            cloud_base_url="https://opencode.ai/inference/go/openai/v1",
            cloud_api_key="new-key",
        ),
    )

    assert report.models == ["m1", "m2"]
    assert calls == [
        ("https://opencode.ai/inference/go/openai/v1", "new-key", "opencode-go")
    ]
    assert "new-key" not in report.model_dump_json()
    assert "old-key" not in report.model_dump_json()


async def test_list_models_rejects_non_llm_capability() -> None:
    service = _service({})
    report = await service.list_models("asr")
    assert report.models == []
    assert "暂不支持" in report.detail


async def test_llm_test_uses_unsaved_overrides_and_preset() -> None:
    """「测试连接」测的是表单当前值，不是已保存配置；密钥不落进结论。"""
    llm = RecordingLlmProbe()
    service = _service(
        {
            "DESKPET_LLM_PROVIDER": "cloud",
            "DESKPET_LLM_BASE_URL": "https://old.example.com/v1",
            "DESKPET_LLM_MODEL": "old-model",
            "DESKPET_LLM_API_KEY": "old-key",
        },
        llm_probe=llm,
    )

    response = await service.test(
        "llm",
        ProviderTestOverrides(
            provider="cloud",
            preset="opencode-go",
            cloud_base_url="https://opencode.ai/inference/go/openai/v1",
            cloud_model="deepseek-v4.1-flash",
            cloud_api_key="new-key",
        ),
    )

    assert llm.calls == [
        (
            "https://opencode.ai/inference/go/openai/v1",
            "new-key",
            "deepseek-v4.1-flash",
        )
    ]
    assert llm.presets == ["opencode-go"]
    assert "new-key" not in response.model_dump_json()
    assert "old-key" not in response.model_dump_json()


async def test_asr_and_tts_test_use_unsaved_overrides() -> None:
    """ASR/TTS 的未保存表单也走同一套 overrides。"""
    asr_probe = RecordingAsrCloudProbe()
    asr_service = _service(
        {"DESKPET_ASR_PROVIDER": "local", "DESKPET_ASR_MODEL": "small"},
        asr_cloud_probe=asr_probe,
    )
    await asr_service.test(
        "asr",
        ProviderTestOverrides(
            provider="cloud",
            cloud_base_url="https://api.groq.com/openai/v1",
            cloud_model="whisper-large-v3-turbo",
            cloud_api_key="asr-key",
        ),
    )
    assert asr_probe.calls == [
        ("https://api.groq.com/openai/v1", "asr-key", "whisper-large-v3-turbo")
    ]

    tts_probe = RecordingTtsProbe()
    tts_service = _service({}, tts_probe=tts_probe)
    await tts_service.test(
        "tts",
        ProviderTestOverrides(local_base_url="http://127.0.0.1:9999", local_token="tts-key"),
    )
    assert tts_probe.calls == [("http://127.0.0.1:9999", "tts-key")]


def test_test_overrides_mask_secrets_in_repr_and_dump() -> None:
    """SecretStr 防止密钥被 repr / model_dump 意外带进日志。"""
    overrides = ProviderTestOverrides(cloud_api_key="sk-probe-secret", local_token="tok-probe")
    assert "sk-probe-secret" not in repr(overrides)
    assert "tok-probe" not in repr(overrides)
    assert "sk-probe-secret" not in overrides.model_dump_json()


async def test_llm_without_any_endpoint_gets_actionable_hint() -> None:
    """一个端点都没配时不能假装「测试通过」，要直接告诉用户填哪两个键。"""
    service = _service({}, llm_probe=RecordingLlmProbe())

    response = await service.test("llm")

    assert len(response.results) == 1
    assert response.results[0].ok is False
    assert response.results[0].detail == HINT_NO_LLM_ENDPOINT


async def test_llm_results_never_carry_the_api_key() -> None:
    """密钥只进探测函数；探测结论序列化后绝不允许出现它（§6.13 的硬约束）。"""
    llm = RecordingLlmProbe(ProbeOutcome(False, "HTTP 401：invalid api key", 5))
    service = _service(CLOUD_AND_LOCAL_ENV, llm_probe=llm)

    response = await service.test("llm")

    assert llm.calls[0][1] == SECRET
    assert SECRET not in response.model_dump_json()


async def test_cloud_asr_without_endpoint_gets_actionable_hint() -> None:
    """选了 cloud 但没填端点：明确告诉用户填哪三个键，而不是假装探测通过（T2.4）。"""
    service = _service({"DESKPET_ASR_PROVIDER": "cloud"})

    asr = await service.test("asr")

    assert asr.results[0].ok is False
    assert asr.results[0].detail == HINT_NO_ASR_ENDPOINT


async def test_cloud_asr_probes_configured_endpoint_and_never_carries_key() -> None:
    """云端 ASR 配了端点就真的探它；密钥只进探测函数，不进结论（T2.4 / §6.13）。"""
    probe = RecordingAsrCloudProbe()
    env = {
        "DESKPET_ASR_PROVIDER": "cloud",
        "DESKPET_ASR_CLOUD_BASE_URL": "https://api.groq.com/openai/v1",
        "DESKPET_ASR_CLOUD_API_KEY": SECRET,
        "DESKPET_ASR_CLOUD_MODEL": "whisper-large-v3-turbo",
    }
    service = _service(env, asr_cloud_probe=probe)

    asr = await service.test("asr")

    assert probe.calls == [("https://api.groq.com/openai/v1", SECRET, "whisper-large-v3-turbo")]
    assert asr.results[0].ok is True
    assert asr.results[0].base_url == "https://api.groq.com/openai/v1"
    assert SECRET not in asr.model_dump_json()


async def test_edge_tts_probes_voice_and_cloud_tts_still_not_implemented() -> None:
    """TTS：edge 探库与音色名（T2.4）；通用云端合成仍未实现，提示改 edge / local。"""
    edge = RecordingTtsEdgeProbe()
    service = _service(
        {"DESKPET_TTS_PROVIDER": "edge", "DESKPET_TTS_EDGE_VOICE": "zh-CN-XiaoxiaoNeural"},
        tts_edge_probe=edge,
    )

    tts = await service.test("tts")

    assert edge.calls == ["zh-CN-XiaoxiaoNeural"]
    assert tts.results[0].ok is True
    assert tts.results[0].model == "zh-CN-XiaoxiaoNeural"

    cloud = _service({"DESKPET_TTS_PROVIDER": "cloud"})
    tts_cloud = await cloud.test("tts")
    assert tts_cloud.results[0].ok is False
    assert tts_cloud.results[0].detail == HINT_CLOUD_TTS


async def test_local_asr_and_tts_probe_the_local_engines() -> None:
    """本地供给走本地探测：ASR 拿模型名与缓存目录，TTS 拿适配器地址与口令。"""
    asr_probe = RecordingAsrProbe()
    tts_probe = RecordingTtsProbe()
    env = {
        "DESKPET_ASR_MODEL": "small",
        "DESKPET_ASR_MODEL_DIR": "C:/data/models/asr",
        "DESKPET_TTS_URL": "http://127.0.0.1:8742",
        "DESKPET_TTS_TOKEN": "tok",
    }
    service = _service(env, asr_probe=asr_probe, tts_probe=tts_probe)

    asr = await service.test("asr")
    tts = await service.test("tts")

    assert asr_probe.calls == [("small", Path("C:/data/models/asr"))]
    assert tts_probe.calls == [("http://127.0.0.1:8742", "tok")]
    assert asr.results[0].model == "small"
    assert tts.results[0].base_url == "http://127.0.0.1:8742"


def test_api_route_validates_capability_and_returns_contract_shape() -> None:
    """POST /providers/test 的 OpenAPI 入参校验与响应形状（契约测试的入口）。"""
    settings = load_settings(env=CLOUD_AND_LOCAL_ENV)
    service = ProviderTestService(
        settings,
        llm_probe=RecordingLlmProbe(),
        tts_probe=RecordingTtsProbe(),
        asr_probe=RecordingAsrProbe(),
    )
    with TestClient(create_app(provider_test_service=service)) as client:
        ok = client.post("/providers/test", json={"capability": "llm"})
        bad = client.post("/providers/test", json={"capability": "video"})

    assert ok.status_code == 200
    assert set(ok.json()) == set(ProviderTestResponse.model_fields)
    assert len(ok.json()["results"]) == 3
    assert bad.status_code == 422
