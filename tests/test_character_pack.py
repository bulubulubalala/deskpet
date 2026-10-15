"""文件职责：角色包契约与体检的单测（T1.2；需求 §6.1 / F6）。

为什么单列：角色包格式是 P0 数据契约（PLAN §8.1）——它错了会同时拖累记忆分区、提示词装配、
形象与语音四个模块。这里的用例把「哪些问题拦住加载、哪些只是待补 / 提示」钉死。
"""

from __future__ import annotations

import json
import struct
import wave
from pathlib import Path
from typing import Any

import pytest

from core.errors import PackError
from services.character_store import iter_pack_dirs, load_character_pack, scan_characters

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PACK = REPO_ROOT / "characters" / "amber"

#: 显式传这个值 = 「这个文件不要写」（None 在 JSON 里没有意义，不能当哨兵用）。
_NO_FILE = object()

CARD: dict[str, Any] = {
    "name": "tester",
    "display_name": "测试角色",
    "description": "用于测试的角色。",
    "personality": "认真但不谄媚。",
    "speaking_style": "短句。",
}


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _write_wav(path: Path, seconds: float, sample_rate: int = 24000) -> Path:
    """写一个静音 PCM wav，用来验证参考音时长体检。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * int(seconds * sample_rate))
    return path


def _write_float_wav(path: Path) -> Path:
    """写一个 IEEE float（format=3）wav：标准库 wave 读不了，用来验证降级成 warning。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = b"\x00\x00\x00\x00" * 16
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 3, 1, 24000, 24000 * 4, 4, 32)
    header += b"data" + struct.pack("<I", len(data))
    path.write_bytes(header + data)
    return path


def make_pack(
    root: Path,
    *,
    card: Any = _NO_FILE,
    voice: Any = _NO_FILE,
    emotions: Any = _NO_FILE,
    appearance: Any = _NO_FILE,
    pack_info: Any = _NO_FILE,
    with_portrait: bool = True,
) -> Path:
    """写一个最小角色包；显式传 None 表示「这个文件不写」。"""
    root.mkdir(parents=True, exist_ok=True)
    (root / "assets").mkdir(exist_ok=True)
    if with_portrait:
        (root / "assets" / "portrait.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    payloads: dict[str, Any] = {
        "card.json": CARD if card is _NO_FILE else card,
        "voice.json": (
            {"engine": "indextts", "ref_audio": "assets/reference.wav", "lang": "ZH"}
            if voice is _NO_FILE
            else voice
        ),
        "emotion_map.json": (
            {"喜": {"vector": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}}
            if emotions is _NO_FILE
            else emotions
        ),
        "appearance.json": (
            {
                "stage": "png",
                "portrait": "assets/portrait.png",
                "png_fallback": "assets/portrait.png",
            }
            if appearance is _NO_FILE
            else appearance
        ),
        "pack.json": (
            {"pack_version": 1, "char_id": root.name, "display_name": "测试"}
            if pack_info is _NO_FILE
            else pack_info
        ),
    }
    for name, payload in payloads.items():
        if payload is None:
            continue
        _write_json(root / name, payload)
    return root


def _messages(loaded: Any, level: str) -> list[str]:
    return [issue.message for issue in loaded.issues if issue.level == level]


def test_sample_pack_loads_without_errors() -> None:
    """仓库自带的示例角色包必须始终能加载——它同时是 F1 验收 1 的样板。"""
    loaded = load_character_pack(SAMPLE_PACK)
    assert loaded.char_id == "amber"
    assert loaded.ok, [str(issue) for issue in loaded.issues]
    assert loaded.card.display_name == "琥珀"
    assert loaded.portrait_path is not None
    assert len(loaded.emotions) >= 8


def test_missing_card_json_raises_pack_error(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "nocard", card=None)
    with pytest.raises(PackError) as excinfo:
        load_character_pack(root)
    assert excinfo.value.code == "DP-PACK-001"
    assert "card.json" in excinfo.value.message


def test_broken_card_json_reports_json_error(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "broken", card=None)
    (root / "card.json").write_text("{ 这不是 JSON", encoding="utf-8")
    with pytest.raises(PackError) as excinfo:
        load_character_pack(root)
    assert "不是合法 JSON" in excinfo.value.message


def test_unknown_card_field_is_rejected(tmp_path: Path) -> None:
    """手写 JSON 打错键名要立刻报错，而不是静默忽略（表现是「写了却没生效」）。"""
    root = make_pack(tmp_path / "typo", card=dict(CARD, nope=1))
    with pytest.raises(PackError) as excinfo:
        load_character_pack(root)
    assert "nope" in excinfo.value.message


def test_card_behaviour_bounds_are_enforced(tmp_path: Path) -> None:
    ok_root = make_pack(tmp_path / "ok", card=dict(CARD, proactive=0.9))
    assert load_character_pack(ok_root).card.proactive == 0.9
    bad_root = make_pack(tmp_path / "bad", card=dict(CARD, proactive=1.5))
    with pytest.raises(PackError) as excinfo:
        load_character_pack(bad_root)
    assert "proactive" in excinfo.value.message


def test_missing_voice_and_portrait_are_pending_not_fatal(tmp_path: Path) -> None:
    """F6 验收 2：缺参考音或立绘要列「待补字段」，但角色仍能先跑起来。"""
    root = make_pack(tmp_path / "bare", voice=None, appearance=None, with_portrait=False)
    loaded = load_character_pack(root)
    assert loaded.ok
    pending = loaded.pending_fields
    assert any("voice.json" in item for item in pending)
    assert any("立绘" in item for item in pending)
    assert loaded.ref_audio_path is None
    assert loaded.portrait_path is None


def test_ref_audio_duration_out_of_range_warns(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "short")
    _write_wav(root / "assets" / "reference.wav", 5.0)
    loaded = load_character_pack(root)
    assert loaded.ok
    assert any("5.00s" in item for item in _messages(loaded, "warning"))


def test_ref_audio_duration_in_range_has_no_warning(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "fit")
    _write_wav(root / "assets" / "reference.wav", 9.0)
    loaded = load_character_pack(root)
    assert loaded.ref_audio_path is not None
    assert not [item for item in _messages(loaded, "warning") if "时长" in item]


def test_unreadable_ref_audio_warns_instead_of_failing(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "floatwav")
    _write_float_wav(root / "assets" / "reference.wav")
    loaded = load_character_pack(root)
    assert loaded.ok
    assert any("PCM" in item for item in _messages(loaded, "warning"))


def test_emotion_vector_length_and_range_are_checked(tmp_path: Path) -> None:
    too_short = make_pack(tmp_path / "shortvec", emotions={"喜": {"vector": [1.0, 0.0, 0.0]}})
    short_loaded = load_character_pack(too_short)
    assert not short_loaded.ok
    assert any("vector" in item for item in _messages(short_loaded, "error"))
    out_of_range = make_pack(
        tmp_path / "rangevec",
        emotions={"喜": {"vector": [1.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}},
    )
    assert not load_character_pack(out_of_range).ok


def test_emotion_map_missing_base_tags_warns(tmp_path: Path) -> None:
    root = make_pack(
        tmp_path / "onetag",
        emotions={"害羞": {"vector": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}},
    )
    loaded = load_character_pack(root)
    assert loaded.ok
    assert any("缺少基础情感标签" in item for item in _messages(loaded, "warning"))


def test_pack_char_id_mismatch_keeps_dir_name(tmp_path: Path) -> None:
    """目录名是记忆分区键：包里的 char_id 与目录名不一致时以目录名为准，但要提示。"""
    root = make_pack(tmp_path / "dirname", pack_info={"pack_version": 1, "char_id": "other"})
    loaded = load_character_pack(root)
    assert loaded.char_id == "dirname"
    assert loaded.pack.char_id == "other"
    assert any("不一致" in item for item in _messages(loaded, "warning"))


def test_pack_version_newer_than_supported_is_error(tmp_path: Path) -> None:
    root = make_pack(tmp_path / "newpack", pack_info={"pack_version": 99, "char_id": "newpack"})
    loaded = load_character_pack(root)
    assert not loaded.ok
    assert any("版本" in item for item in _messages(loaded, "error"))


def test_live2d_missing_model_falls_back_to_png(tmp_path: Path) -> None:
    """§6.6：缺 Live2D 模型只 warning，自动回退 PNG。"""
    root = make_pack(
        tmp_path / "live2d",
        appearance={
            "stage": "live2d",
            "model": "assets/x.model3.json",
            "png_fallback": "assets/portrait.png",
        },
    )
    loaded = load_character_pack(root)
    assert loaded.ok
    assert any("回退 PNG" in item for item in _messages(loaded, "warning"))
    assert loaded.portrait_path is not None


def test_scan_characters_reports_broken_packs(tmp_path: Path) -> None:
    """坏包不抛异常，而是带着「坏在哪」出现在结果里（§6.7 的容错要求）。"""
    characters = tmp_path / "characters"
    make_pack(characters / "good")
    make_pack(characters / "broken", card=None)
    (characters / "_shared").mkdir(parents=True)
    (characters / ".hidden").mkdir(parents=True)
    scans = scan_characters(characters)
    assert [scan.char_id for scan in scans] == ["broken", "good"]
    broken, good = scans
    assert broken.pack is None
    assert broken.error is not None
    assert not broken.ok
    assert good.ok
    assert good.pack is not None


def test_iter_pack_dirs_on_missing_dir_returns_empty(tmp_path: Path) -> None:
    assert iter_pack_dirs(tmp_path / "nope") == ()
