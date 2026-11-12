"""从导出包恢复记忆库（D9 第 3 条 / M3）：暂存、替换、留底、失败回滚。

用真实 SQLCipher 库跑（sqlcipher3 是本项目依赖，Windows 轮子自带 amalgamation），
只有这样才能覆盖「换上去的库到底能不能用当前密钥打开」这条关键路径。
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from adapters.memory_sqlite import open_memory_store
from config import Settings
from core.errors import MemoryRestoreError
from core.memory import MessageDraft
from services.restore_service import (
    PENDING_DIR_NAME,
    DataRestoreService,
    apply_pending_restore,
    pending_db_file,
)

#: 两份合法但不同的密钥：第二份用来模拟「换了台机器」
KEY = bytes(range(1, 33))
OTHER_KEY = bytes(range(33, 65))
CHAR = "snow"
NOW = 1_700_000_000.0


def make_settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data", characters_dir=tmp_path / "characters")


def make_db(path: Path, *, text: str, key: bytes = KEY) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    store = open_memory_store(path, key=key)
    try:
        store.add_messages(
            [
                MessageDraft(
                    char_id=CHAR,
                    session_id="s1",
                    role="user",
                    text=text,
                    ts=NOW,
                    token_len=len(text),
                )
            ]
        )
    finally:
        store.close()


def make_archive(tmp_path: Path, *, text: str = "新机器上的记忆", key: bytes = KEY) -> Path:
    """造一个和真实导出包同形的 zip（只需要 memories.db 这一个成员）。"""
    db = tmp_path / "packed" / "memories.db"
    make_db(db, text=text, key=key)
    archive = tmp_path / "deskpet-export-20261109-120000.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(db, "memories.db")
    return archive


def texts_of(path: Path, *, key: bytes = KEY) -> list[str]:
    store = open_memory_store(path, key=key)
    try:
        return [row.text for row in store.recent_messages(CHAR, limit=10)]
    finally:
        store.close()


# --- 暂存 ---------------------------------------------------------------


async def test_stage_extracts_memories_db_into_pending(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    archive = make_archive(tmp_path)

    staged = await DataRestoreService(settings).stage(archive)

    assert staged.pending_path == pending_db_file(settings.data_dir)
    assert staged.pending_path.read_bytes()[:16] != b"", "暂存文件不能是空的"
    assert staged.db_bytes == staged.pending_path.stat().st_size
    assert "memories.db" in staged.entries
    assert not settings.memory_db_file.exists(), "暂存阶段绝不碰线上库"


async def test_stage_rejects_non_zip(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    broken = tmp_path / "not-a-zip.zip"
    broken.write_text("这不是压缩包", encoding="utf-8")

    with pytest.raises(MemoryRestoreError) as caught:
        await DataRestoreService(settings).stage(broken)

    assert "不是 zip 压缩包" in caught.value.message
    assert not pending_db_file(settings.data_dir).exists()


async def test_stage_rejects_zip_without_memories_db(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    archive = tmp_path / "other.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("readme.txt", "hello")

    with pytest.raises(MemoryRestoreError) as caught:
        await DataRestoreService(settings).stage(archive)

    assert "没有 memories.db" in caught.value.message


async def test_stage_rejects_missing_archive(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)

    with pytest.raises(MemoryRestoreError) as caught:
        await DataRestoreService(settings).stage(tmp_path / "nope.zip")

    assert "找不到数据包" in caught.value.message


# --- 生效 ---------------------------------------------------------------


async def test_apply_replaces_db_and_keeps_backup(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    make_db(settings.memory_db_file, text="旧机器上的记忆")
    archive = make_archive(tmp_path, text="恢复回来的记忆")
    await DataRestoreService(settings).stage(archive)

    installed = apply_pending_restore(settings, key=KEY)

    assert installed == settings.memory_db_file
    assert texts_of(settings.memory_db_file) == ["恢复回来的记忆"]
    backups = sorted((settings.data_dir / "backups").glob("memories-replaced-*.db"))
    assert len(backups) == 1, "替换前的库必须留底，且只留一份"
    assert texts_of(backups[0]) == ["旧机器上的记忆"]
    assert not pending_db_file(settings.data_dir).exists(), "暂存文件应该被消费掉"


async def test_apply_rolls_back_when_key_does_not_match(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    make_db(settings.memory_db_file, text="旧机器上的记忆")
    archive = make_archive(tmp_path, text="别人的记忆", key=OTHER_KEY)
    await DataRestoreService(settings).stage(archive)

    assert apply_pending_restore(settings, key=KEY) is None

    # 老库原样可用，残骸挪进 backups/，不留在记忆库路径上
    assert texts_of(settings.memory_db_file) == ["旧机器上的记忆"]
    rejected = list((settings.data_dir / "backups").glob("memories-rejected-*.db"))
    assert len(rejected) == 1


async def test_apply_without_pending_is_noop(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)

    assert apply_pending_restore(settings, key=KEY) is None
    assert not (settings.data_dir / PENDING_DIR_NAME).exists()


async def test_apply_takes_over_when_there_is_no_current_db(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    archive = make_archive(tmp_path, text="第一次恢复")
    await DataRestoreService(settings).stage(archive)

    assert apply_pending_restore(settings, key=KEY) == settings.memory_db_file

    assert texts_of(settings.memory_db_file) == ["第一次恢复"]
    assert not (settings.data_dir / "backups").exists() or not list(
        (settings.data_dir / "backups").glob("memories-replaced-*.db")
    ), "本来就没有库，不该假装留底"
