"""文件职责：角色包的读盘、体检与列举（需求 §6.1 / F6，T1.2 落地）。

依赖方向：services -> contracts + core；不 import api / adapters。
谁调用：角色列表与热重载（T1.12）、/persona/import 的同一套体检、测试。
约定：体检分三级——error 拦住加载、pending 是「待补字段」（允许先跑起来）、warning 只提示；
     「无 BGM / 单人」机器判不出来，这里不猜，只做「文件在不在 + 时长 + 能不能解析」。
"""

from __future__ import annotations

import json
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from contracts.character import (
    DEFAULT_PORTRAIT,
    DEFAULT_REF_AUDIO,
    EMOTION_DIMENSION_TAGS,
    REF_AUDIO_MAX_S,
    REF_AUDIO_MIN_S,
    AppearanceConfig,
    CharacterCard,
    EmotionEntry,
    EmotionMap,
    PackInfo,
    VoiceConfig,
)
from contracts.errors import CODE_PACK_FIELD_MISSING
from core.errors import PackError

CARD_FILE = "card.json"
VOICE_FILE = "voice.json"
EMOTIONS_FILE = "emotion_map.json"
APPEARANCE_FILE = "appearance.json"
PACK_FILE = "pack.json"
ASSETS_DIR = "assets"
#: 下划线 / 点开头的目录不是角色（_shared 之类），列举时跳过。
SKIPPED_DIR_PREFIXES = ("_", ".")

#: 体检结论的三种级别。pending 对应需求里的「待补字段」。
IssueLevel = Literal["error", "pending", "warning"]


@dataclass(frozen=True, slots=True)
class PackIssue:
    """体检发现的一条问题。file 是出问题的文件（相对角色包根目录）。"""

    level: IssueLevel
    file: str
    message: str

    def __str__(self) -> str:
        return "[" + self.level + "] " + (self.file or "<包>") + "：" + self.message


@dataclass(frozen=True, slots=True)
class LoadedPack:
    """一个已经读进内存的角色包（磁盘仍是唯一正本，这里只是快照）。"""

    char_id: str
    root: Path
    card: CharacterCard
    voice: VoiceConfig
    emotions: dict[str, EmotionEntry]
    appearance: AppearanceConfig
    pack: PackInfo
    issues: tuple[PackIssue, ...] = ()

    @property
    def ok(self) -> bool:
        """没有 error 级问题就算「能加载」——pending 与 warning 不拦（F6 验收 2）。"""
        return not any(issue.level == "error" for issue in self.issues)

    @property
    def pending_fields(self) -> tuple[str, ...]:
        """「待补字段」清单，导入向导与设置页直接拿去显示。"""
        return tuple(issue.message for issue in self.issues if issue.level == "pending")

    def asset_path(self, relative: str) -> Path:
        """相对路径 -> 绝对路径。不检查存在性（那是体检的事）。"""
        return self.root / relative

    @property
    def ref_audio_path(self) -> Path | None:
        """可用的参考音；没有就返回 None（调用方走纯文字，别抛异常）。"""
        candidate = self.root / (self.voice.ref_audio or DEFAULT_REF_AUDIO)
        return candidate if candidate.is_file() else None

    @property
    def portrait_path(self) -> Path | None:
        """可用的 PNG 立绘；没有就返回 None（界面用内置占位图）。"""
        candidate = self.root / (self.appearance.portrait or DEFAULT_PORTRAIT)
        return candidate if candidate.is_file() else None


@dataclass(frozen=True, slots=True)
class PackScan:
    """列举一个角色目录的结果：要么加载成功，要么带一句「坏在哪」（§6.7 的容错要求）。"""

    char_id: str
    root: Path
    pack: LoadedPack | None
    error: str | None

    @property
    def ok(self) -> bool:
        return self.pack is not None and self.pack.ok


def _read_json(path: Path) -> tuple[object | None, str | None]:
    """读一个 JSON 文件：返回 (数据, 错误文案)。文件不存在返回 (None, None)。"""
    if not path.is_file():
        return None, None
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except OSError as exc:
        return None, "读取失败：" + str(exc)
    except json.JSONDecodeError as exc:
        return None, f"不是合法 JSON（第 {exc.lineno} 行第 {exc.colno} 列）：{exc.msg}"


def _format_validation_error(exc: ValidationError, limit: int = 3) -> str:
    """把 pydantic 的报错压成一行（只列前几条，避免把日志和界面刷爆）。"""
    parts: list[str] = []
    for error in exc.errors()[:limit]:
        location = ".".join(str(item) for item in error["loc"]) or "<根>"
        parts.append(location + "：" + str(error["msg"]))
    extra = len(exc.errors()) - limit
    return "；".join(parts) + (f"（另有 {extra} 处）" if extra > 0 else "")


def _wav_duration_s(path: Path) -> tuple[float | None, str | None]:
    """用标准库读 PCM wav 时长：返回 (秒, 错误文案)。不依赖 soundfile / ffmpeg。"""
    try:
        with wave.open(str(path), "rb") as handle:
            frame_rate = handle.getframerate()
            if frame_rate <= 0:
                return None, "帧率读到 0，文件可疑"
            return handle.getnframes() / frame_rate, None
    except wave.Error as exc:
        return None, "只支持未压缩 PCM wav，读不了：" + str(exc)
    except OSError as exc:
        return None, "读取失败：" + str(exc)


def _require_card(root: Path) -> CharacterCard:
    """card.json 是唯一「读不出来就没法玩」的文件，所以它坏到拿不到人格时直接抛异常。"""
    data, error = _read_json(root / CARD_FILE)
    if error is not None:
        raise PackError(
            CODE_PACK_FIELD_MISSING,
            "角色包 " + root.name + " 的 card.json " + error,
            user_hint="先修好 card.json 的 JSON 语法，再重新加载",
            context={"file": CARD_FILE, "root": str(root)},
        )
    if data is None:
        raise PackError(
            CODE_PACK_FIELD_MISSING,
            "角色包 " + root.name + " 缺少 card.json",
            user_hint=(
                "card.json 是必填文件（§6.1），至少要有 name / display_name / "
                "description / personality / speaking_style"
            ),
            context={"file": CARD_FILE, "root": str(root)},
        )
    try:
        return CharacterCard.model_validate(data)
    except ValidationError as exc:
        raise PackError(
            CODE_PACK_FIELD_MISSING,
            "card.json 字段不合法：" + _format_validation_error(exc),
            user_hint="按需求 §6.1 的字段表补齐",
            context={"file": CARD_FILE, "root": str(root)},
        ) from exc


def _load_pack_info(root: Path, char_id: str) -> tuple[PackInfo, list[PackIssue]]:
    """pack.json 缺失不算错：按目录名补齐即可（手写一个角色也不该被拦住）。"""
    issues: list[PackIssue] = []
    data, error = _read_json(root / PACK_FILE)
    if error is not None:
        issues.append(PackIssue("error", PACK_FILE, error))
        return PackInfo(char_id=char_id), issues
    if data is None:
        issues.append(
            PackIssue("pending", PACK_FILE, f"待补：pack.json（先按目录名 {char_id} 处理）")
        )
        return PackInfo(char_id=char_id), issues
    try:
        info = PackInfo.model_validate(data)
    except ValidationError as exc:
        issues.append(PackIssue("error", PACK_FILE, _format_validation_error(exc)))
        return PackInfo(char_id=char_id), issues
    if info.char_id != char_id:
        issues.append(
            PackIssue(
                "warning",
                PACK_FILE,
                f"char_id={info.char_id} 与目录名 {char_id} 不一致，按目录名走（记忆按目录名分区）",
            )
        )
    return info, issues


def _check_ref_audio(root: Path, voice: VoiceConfig) -> list[PackIssue]:
    """参考音体检：在不在、能不能解析、时长是否落在 8–12s。"""
    issues: list[PackIssue] = []
    relative = voice.ref_audio or DEFAULT_REF_AUDIO
    path = root / relative
    if not path.is_file():
        issues.append(
            PackIssue(
                "pending", VOICE_FILE, f"待补：参考音 {relative}（文件不存在，角色暂时没声音）"
            )
        )
        return issues
    duration, error = _wav_duration_s(path)
    if error is not None:
        issues.append(PackIssue("warning", VOICE_FILE, f"参考音 {relative} {error}（时长没核对）"))
        return issues
    if duration is None:
        return issues
    if not REF_AUDIO_MIN_S <= duration <= REF_AUDIO_MAX_S:
        issues.append(
            PackIssue(
                "warning",
                VOICE_FILE,
                f"参考音 {relative} 时长 {duration:.2f}s，"
                f"建议 {REF_AUDIO_MIN_S:.0f}–{REF_AUDIO_MAX_S:.0f}s（§6.1）",
            )
        )
    return issues


def _load_voice(root: Path) -> tuple[VoiceConfig, list[PackIssue]]:
    """voice.json + 参考音体检；出错就退回默认配置（角色还能以纯文字继续）。"""
    issues: list[PackIssue] = []
    data, error = _read_json(root / VOICE_FILE)
    if error is not None:
        issues.append(PackIssue("error", VOICE_FILE, error))
        return VoiceConfig(), issues
    if data is None:
        issues.append(
            PackIssue("pending", VOICE_FILE, "待补：voice.json（没有音色配置就只能纯文字聊）")
        )
        return VoiceConfig(), issues
    try:
        voice = VoiceConfig.model_validate(data)
    except ValidationError as exc:
        issues.append(PackIssue("error", VOICE_FILE, _format_validation_error(exc)))
        return VoiceConfig(), issues
    issues.extend(_check_ref_audio(root, voice))
    return voice, issues


def _load_emotions(root: Path) -> tuple[dict[str, EmotionEntry], list[PackIssue]]:
    """emotion_map.json：标签表。缺标签只 warning，因为台词照说，只是表情不动。"""
    issues: list[PackIssue] = []
    data, error = _read_json(root / EMOTIONS_FILE)
    if error is not None:
        issues.append(PackIssue("error", EMOTIONS_FILE, error))
        return {}, issues
    if data is None:
        issues.append(
            PackIssue(
                "pending", EMOTIONS_FILE, "待补：emotion_map.json（情感只影响台词，不切表情）"
            )
        )
        return {}, issues
    try:
        emotions = EmotionMap.model_validate(data).root
    except ValidationError as exc:
        issues.append(PackIssue("error", EMOTIONS_FILE, _format_validation_error(exc)))
        return {}, issues
    missing = [tag for tag in EMOTION_DIMENSION_TAGS if tag not in emotions]
    if missing:
        issues.append(
            PackIssue(
                "warning",
                EMOTIONS_FILE,
                "缺少基础情感标签：" + "、".join(missing) + "（LLM 说出来时退化为纯台词）",
            )
        )
    return emotions, issues


def _check_appearance_assets(root: Path, appearance: AppearanceConfig) -> list[PackIssue]:
    """形象体检：Live2D 缺模型只 warning（§6.6 自动回退 PNG），缺立绘是待补。"""
    issues: list[PackIssue] = []
    portrait_relative = appearance.portrait or DEFAULT_PORTRAIT
    portrait_exists = (root / portrait_relative).is_file()
    model_relative = appearance.model
    model_exists = bool(model_relative) and (root / str(model_relative)).is_file()
    if appearance.stage in ("live2d", "hybrid") and not model_exists:
        issues.append(
            PackIssue(
                "warning",
                APPEARANCE_FILE,
                "Live2D 模型 " + (model_relative or "<未填写>") + " 不存在，自动回退 PNG（§6.6）",
            )
        )
    if portrait_exists:
        return issues
    if appearance.stage == "live2d" and model_exists:
        # 有 Live2D 模型就还能跑，立绘只是可选回退素材。
        issues.append(
            PackIssue(
                "warning",
                APPEARANCE_FILE,
                f"立绘 {portrait_relative} 不存在（Live2D 可用，不影响显示）",
            )
        )
        return issues
    issues.append(
        PackIssue(
            "pending", APPEARANCE_FILE, f"待补：立绘 {portrait_relative}（界面暂时用内置占位图）"
        )
    )
    fallback_relative = appearance.png_fallback
    if fallback_relative and not (root / fallback_relative).is_file():
        issues.append(
            PackIssue(
                "warning",
                APPEARANCE_FILE,
                f"png_fallback {fallback_relative} 不存在（回退时会用内置占位图）",
            )
        )
    return issues


def _load_appearance(root: Path) -> tuple[AppearanceConfig, list[PackIssue]]:
    """appearance.json + 素材体检；出错就退回「纯 PNG」配置。"""
    issues: list[PackIssue] = []
    data, error = _read_json(root / APPEARANCE_FILE)
    if error is not None:
        issues.append(PackIssue("error", APPEARANCE_FILE, error))
        return AppearanceConfig(), issues
    if data is None:
        issues.append(
            PackIssue("pending", APPEARANCE_FILE, "待补：appearance.json（先按 PNG 立绘处理）")
        )
        return AppearanceConfig(), issues
    try:
        appearance = AppearanceConfig.model_validate(data)
    except ValidationError as exc:
        issues.append(PackIssue("error", APPEARANCE_FILE, _format_validation_error(exc)))
        return AppearanceConfig(), issues
    issues.extend(_check_appearance_assets(root, appearance))
    return appearance, issues


def load_character_pack(root: Path) -> LoadedPack:
    """加载一个角色目录并体检（唯一的读入口）。

    只有 card.json 坏到拿不到人格、或目录本身不存在时才抛 PackError；
    其余问题都变成 issues 带回去（F6 验收 2：缺参考音或立绘也能先跑起来）。
    """
    if not root.is_dir():
        raise PackError(
            CODE_PACK_FIELD_MISSING,
            "角色包目录不存在：" + str(root),
            user_hint="确认 characters/ 下确实有这个目录",
            context={"root": str(root)},
        )
    card = _require_card(root)
    char_id = root.name
    pack_info, pack_issues = _load_pack_info(root, char_id)
    voice, voice_issues = _load_voice(root)
    emotions, emotion_issues = _load_emotions(root)
    appearance, appearance_issues = _load_appearance(root)
    issues = [*pack_issues, *voice_issues, *emotion_issues, *appearance_issues]
    if not (root / ASSETS_DIR).is_dir():
        issues.append(
            PackIssue("pending", ASSETS_DIR, "待补：assets/ 目录（立绘与参考音都放这里）")
        )
    return LoadedPack(
        char_id=char_id,
        root=root,
        card=card,
        voice=voice,
        emotions=emotions,
        appearance=appearance,
        pack=pack_info,
        issues=tuple(issues),
    )


def iter_pack_dirs(characters_dir: Path) -> tuple[Path, ...]:
    """列出角色目录（按名字排序）；下划线 / 点开头的目录跳过。"""
    if not characters_dir.is_dir():
        return ()
    candidates = [
        path
        for path in characters_dir.iterdir()
        if path.is_dir() and not path.name.startswith(SKIPPED_DIR_PREFIXES)
    ]
    return tuple(sorted(candidates, key=lambda path: path.name.lower()))


def scan_characters(characters_dir: Path) -> tuple[PackScan, ...]:
    """扫描整个 characters/：坏包不抛异常，而是带着「坏在哪」出现在结果里。"""
    scans: list[PackScan] = []
    for root in iter_pack_dirs(characters_dir):
        try:
            loaded = load_character_pack(root)
        except PackError as exc:
            scans.append(PackScan(char_id=root.name, root=root, pack=None, error=str(exc)))
            continue
        scans.append(PackScan(char_id=root.name, root=root, pack=loaded, error=None))
    return tuple(scans)


__all__ = [
    "APPEARANCE_FILE",
    "ASSETS_DIR",
    "CARD_FILE",
    "EMOTIONS_FILE",
    "PACK_FILE",
    "VOICE_FILE",
    "LoadedPack",
    "PackIssue",
    "PackScan",
    "iter_pack_dirs",
    "load_character_pack",
    "scan_characters",
]
