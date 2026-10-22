"""文件职责：T0.8 打包相关的配置测试——默认数据目录在源码态与打包态必须不同。

为什么单列：打包后 __file__ 指向 bundle 内部，若默认数据目录仍按源码路径推导，
sidecar 会把 runtime.json / 日志写进只读资源目录，表现为「起来就崩」或「文件写不进去」，
而这类错误在开发态永远复现不出来（CODE_STYLE §7：测试必须无硬件可跑，且覆盖真实分支）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

import config
from config import default_characters_dir, default_data_dir, load_settings


def test_source_mode_data_dir_is_repo_data() -> None:
    """源码态：默认数据目录仍是仓库根 data/，与 .env.example 保持一致。"""
    assert default_data_dir(frozen=False) == config.SOURCE_ROOT / "data"


def test_frozen_mode_data_dir_sits_next_to_executable(tmp_path: Path) -> None:
    """打包态：默认数据目录落在 sidecar.exe 旁边，而不是 bundle 内部的 __file__ 旁边。"""
    executable = tmp_path / "sidecar.exe"
    assert default_data_dir(frozen=True, executable=str(executable)) == tmp_path / "data"


def test_env_data_dir_overrides_default(tmp_path: Path) -> None:
    """DESKPET_DATA_DIR 优先级最高（Electron 打包态就是靠它把数据落到 userData）。"""
    settings = load_settings(env={"DESKPET_DATA_DIR": str(tmp_path)})
    assert settings.data_dir == tmp_path
    assert settings.runtime_file == tmp_path / "runtime.json"
    assert settings.log_file == tmp_path / "logs" / "deskpet.log"


def test_source_mode_characters_dir_is_repo_characters() -> None:
    """源码态：角色包目录默认是仓库根 characters/（§9.1）。"""
    assert default_characters_dir(frozen=False) == config.SOURCE_ROOT / "characters"


def test_env_characters_dir_overrides_default(tmp_path: Path) -> None:
    """DESKPET_CHARACTERS_DIR 优先级最高：打包态角色包必须落在可写的 userData 下。"""
    settings = load_settings(env={"DESKPET_CHARACTERS_DIR": str(tmp_path)})
    assert settings.characters_dir == tmp_path


def test_asr_defaults_match_dotenv_example() -> None:
    """T1.4：ASR 默认值（D4：small + int8 + CPU）必须与 .env.example 写的一致。"""
    settings = load_settings(env={})
    assert settings.asr.model == "small"
    assert settings.asr.device == "cpu"
    assert settings.asr.compute_type == "int8"
    assert settings.asr.beam_size == 1
    assert settings.asr.timeout_s == 15.0
    assert settings.asr.vad_filter is True
    assert settings.asr.language == ""
    assert settings.asr.model_dir == config.DEFAULT_DATA_DIR / "models" / "asr"


def test_asr_model_dir_follows_data_dir(tmp_path: Path) -> None:
    """模型缓存跟着数据目录走：打包态不许把 460MB 模型写进只读的 resources。"""
    settings = load_settings(env={"DESKPET_DATA_DIR": str(tmp_path)})
    assert settings.asr.model_dir == tmp_path / "models" / "asr"


def test_asr_env_overrides(tmp_path: Path) -> None:
    settings = load_settings(
        env={
            "DESKPET_ASR_MODEL": "medium",
            "DESKPET_ASR_DEVICE": "cuda",
            "DESKPET_ASR_COMPUTE_TYPE": "float16",
            "DESKPET_ASR_MODEL_DIR": str(tmp_path),
            "DESKPET_ASR_LANGUAGE": "zh",
            "DESKPET_ASR_BEAM_SIZE": "5",
            "DESKPET_ASR_TIMEOUT_S": "30",
            "DESKPET_ASR_VAD": "false",
            "DESKPET_ASR_HF_ENDPOINT": "https://hf-mirror.com",
        }
    )
    assert settings.asr.model == "medium"
    assert settings.asr.device == "cuda"
    assert settings.asr.compute_type == "float16"
    assert settings.asr.model_dir == tmp_path
    assert settings.asr.language == "zh"
    assert settings.asr.beam_size == 5
    assert settings.asr.timeout_s == 30.0
    assert settings.asr.vad_filter is False
    assert settings.asr.hf_endpoint == "https://hf-mirror.com"


def test_asr_switch_rejects_garbage() -> None:
    """开关写错要立刻报错，不能默默当成关：否则「噪声被送去识别」这种问题极难查。"""
    with pytest.raises(ValueError, match="DESKPET_ASR_VAD"):
        load_settings(env={"DESKPET_ASR_VAD": "也许"})


def test_tts_defaults_match_dotenv_example() -> None:
    """T1.5：TTS 适配器默认值（§6.12：只听 127.0.0.1:8742）必须与 .env.example 一致。"""
    settings = load_settings(env={})
    assert settings.tts.base_url == "http://127.0.0.1:8742"
    assert settings.tts.token == ""
    assert settings.tts.timeout_s == 30.0


def test_tts_env_overrides() -> None:
    settings = load_settings(
        env={
            "DESKPET_TTS_URL": "http://127.0.0.1:9999",
            "DESKPET_TTS_TOKEN": "secret",
            "DESKPET_TTS_TIMEOUT_S": "12.5",
        }
    )
    assert settings.tts.base_url == "http://127.0.0.1:9999"
    assert settings.tts.token == "secret"
    assert settings.tts.timeout_s == 12.5


def test_tts_timeout_rejects_garbage() -> None:
    """配错了要说出来：静默用默认值会让「为什么还是 30s」这种问题极难查。"""
    with pytest.raises(ValueError, match="DESKPET_TTS_TIMEOUT_S"):
        load_settings(env={"DESKPET_TTS_TIMEOUT_S": "很久"})


def test_provider_defaults_match_dotenv_example() -> None:
    """T1.14：不配 provider 时保持现状——LLM 云端、ASR / TTS 本地（§6.13）。"""
    settings = load_settings(env={})
    assert settings.llm.provider == "cloud"
    assert settings.asr.provider == "local"
    assert settings.tts.provider == "local"


def test_provider_env_overrides() -> None:
    """三个能力面各自可切：本地 LLM 只是换 base_url，云端 ASR / TTS 先记下选择。"""
    settings = load_settings(
        env={
            "DESKPET_LLM_PROVIDER": "local",
            "DESKPET_LLM_LOCAL_BASE_URL": "http://127.0.0.1:11434/v1",
            "DESKPET_LLM_LOCAL_API_KEY": "ollama",
            "DESKPET_LLM_LOCAL_MODEL": "qwen2.5:7b",
            "DESKPET_ASR_PROVIDER": "cloud",
            "DESKPET_TTS_PROVIDER": "cloud",
        }
    )
    assert settings.llm.provider == "local"
    assert settings.llm.local_base_url == "http://127.0.0.1:11434/v1"
    assert settings.llm.local_api_key == "ollama"
    assert settings.llm.local_model == "qwen2.5:7b"
    assert settings.asr.provider == "cloud"
    assert settings.tts.provider == "cloud"


def test_provider_rejects_garbage() -> None:
    """写错要立刻报错：静默回落会让「我明明配了本地」这种问题极难查。"""
    with pytest.raises(ValueError, match="DESKPET_LLM_PROVIDER"):
        load_settings(env={"DESKPET_LLM_PROVIDER": "edge"})
    with pytest.raises(ValueError, match="DESKPET_ASR_PROVIDER"):
        load_settings(env={"DESKPET_ASR_PROVIDER": "远程"})


def test_llm_endpoint_specs_prefers_selected_provider() -> None:
    """provider=local 时本地端点排第一，显式备用第二、云端第三（§6.7 第二层降级）。"""
    settings = load_settings(
        env={
            "DESKPET_LLM_PROVIDER": "local",
            "DESKPET_LLM_BASE_URL": "https://cloud.example.com/v1",
            "DESKPET_LLM_API_KEY": "cloud-key",
            "DESKPET_LLM_MODEL": "cloud-model",
            "DESKPET_LLM_LOCAL_BASE_URL": "http://127.0.0.1:11434/v1",
            "DESKPET_LLM_LOCAL_MODEL": "local-model",
            "DESKPET_LLM_FALLBACK_BASE_URL": "https://backup.example.com/v1",
            "DESKPET_LLM_FALLBACK_MODEL": "backup-model",
        }
    )
    assert settings.llm.endpoint_specs() == (
        ("http://127.0.0.1:11434/v1", "", "local-model", "local"),
        ("https://backup.example.com/v1", "", "backup-model", "fallback"),
        ("https://cloud.example.com/v1", "cloud-key", "cloud-model", "cloud"),
    )


def test_llm_endpoint_specs_skips_unconfigured_provider() -> None:
    """另一条供给没配就不进候选：不允许拿空端点当端点试（§6.7 不无限转圈）。"""
    settings = load_settings(
        env={
            "DESKPET_LLM_BASE_URL": "https://cloud.example.com/v1",
            "DESKPET_LLM_MODEL": "cloud-model",
        }
    )
    assert settings.llm.endpoint_specs() == (
        ("https://cloud.example.com/v1", "", "cloud-model", "cloud"),
    )


# ---------------------------------------------------------------- 行为记忆（T2.1c）


def test_behavior_memory_defaults_match_dotenv_example() -> None:
    """观察预算与总开关的默认值必须与 .env.example 写的一致，否则用户改不动。"""
    memory = load_settings(env={}).memory
    assert memory.observation_budget_tokens == 200
    assert memory.behavior_enabled is True


def test_memory_retention_defaults_match_dotenv_example() -> None:
    memory = load_settings(env={}).memory
    assert memory.retention_days == 7.0
    assert memory.permanent_importance == 0.8


def test_memory_retention_env_overrides() -> None:
    memory = load_settings(
        env={
            "DESKPET_MEMORY_RETENTION_DAYS": "0",
            "DESKPET_MEMORY_PERMANENT_IMPORTANCE": "0.9",
        }
    ).memory
    assert memory.retention_days == 0.0
    assert memory.permanent_importance == 0.9


def test_behavior_memory_env_overrides_defaults() -> None:
    memory = load_settings(
        env={
            "DESKPET_MEMORY_OBSERVATION_BUDGET_TOKENS": "0",
            "DESKPET_MEMORY_BEHAVIOR_ENABLED": "off",
        }
    ).memory
    assert memory.observation_budget_tokens == 0, "0 = 这一层不注入，必须真的能关"
    assert memory.behavior_enabled is False


def test_behavior_memory_blank_flag_keeps_default() -> None:
    """空串是「没配」而不是「关」——.env 里留空键不该把功能悄悄关掉。"""
    memory = load_settings(env={"DESKPET_MEMORY_BEHAVIOR_ENABLED": ""}).memory
    assert memory.behavior_enabled is True


@pytest.mark.parametrize("value", ["也许", "2", "enabled"])
def test_behavior_memory_rejects_unknown_flag(value: str) -> None:
    """未知取值必须直接报错并点名键名：静默当成 true 会让人以为开关坏了。"""
    with pytest.raises(ValueError, match="DESKPET_MEMORY_BEHAVIOR_ENABLED"):
        load_settings(env={"DESKPET_MEMORY_BEHAVIOR_ENABLED": value})
