"""迁移安全（D3）：迁移前留底、迁移后逐表对数与 FTS 自检。

真迁移（v7 -> v8）用「造一个旧库」的方式模拟：先用当前 schema 建库写入数据，
再把 user_version 改回 7，重新打开时就会走迁移路径。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlcipher3 import dbapi2 as sqlcipher

from adapters.memory_schema import BACKUP_DIR_NAME, SCHEMA_VERSION
from adapters.memory_sqlite import MemorySqliteStore, open_memory_store
from core.memory import MemoryBackendError, MemoryDraft, MessageDraft, RecallQuery

KEY = bytes(range(1, 33))
CHAR = "amber"
NOW = 1_700_000_000.0


def seed(path: Path) -> None:
    """写两条可读数据，迁移后要还在。"""
    store = open_memory_store(path, key=KEY)
    try:
        store.add_messages(
            [
                MessageDraft(
                    char_id=CHAR, session_id="s1", role="user", text="你好", ts=NOW
                )
            ]
        )
        store.upsert_memory(
            MemoryDraft(char_id=CHAR, kind="fact", text="用户喜欢猫", importance=0.8),
            now=NOW,
        )
    finally:
        store.close()


def downgrade(path: Path, version: int) -> None:
    """把 user_version 改小，模拟「旧版程序留下的库」。"""
    conn = sqlcipher.connect(str(path))
    try:
        conn.execute(f'PRAGMA key = "x\'{KEY.hex()}\'"')
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
    finally:
        conn.close()


def test_migration_keeps_backup_and_data(tmp_path: Path) -> None:
    path = tmp_path / "memories.db"
    seed(path)
    downgrade(path, 7)

    reopened = open_memory_store(path, key=KEY)
    try:
        assert reopened.recent_messages(CHAR, limit=10)
        hits = reopened.search_memories(RecallQuery(char_id=CHAR, query="猫", limit=5))
        assert hits[0].text == "用户喜欢猫"
    finally:
        reopened.close()

    backups = sorted((tmp_path / BACKUP_DIR_NAME).glob("memories-pre-v7-*.db"))
    assert len(backups) == 1  # 迁移前留底一份
    assert backups[0].stat().st_size > 0


def test_fresh_database_has_no_backup(tmp_path: Path) -> None:
    opened = open_memory_store(tmp_path / "memories.db", key=KEY)
    opened.close()

    assert not (tmp_path / BACKUP_DIR_NAME).exists()


def test_old_backups_are_pruned(tmp_path: Path) -> None:
    path = tmp_path / "memories.db"
    seed(path)
    backups = tmp_path / BACKUP_DIR_NAME
    backups.mkdir()
    for stamp in ("20260101-000000", "20260102-000000", "20260103-000000", "20260104-000000"):
        (backups / f"memories-pre-v7-{stamp}.db").write_bytes(b"old")
    downgrade(path, 7)

    opened = open_memory_store(path, key=KEY)
    opened.close()

    kept = sorted(p.name for p in backups.glob("memories-pre-v7-*.db"))
    assert len(kept) == 3  # 只留最近 3 份
    assert "memories-pre-v7-20260101-000000.db" not in kept


def test_self_check_rejects_lost_rows(tmp_path: Path) -> None:
    store = open_memory_store(tmp_path / "memories.db", key=KEY)
    try:
        with pytest.raises(MemoryBackendError, match="迁移自检失败"):
            store._schema._verify_migration({"messages": 999}, None)
    finally:
        store.close()


def test_newer_database_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "memories.db"
    seed(path)
    downgrade(path, SCHEMA_VERSION + 1)

    with pytest.raises(MemoryBackendError, match="高于本程序支持"):
        MemorySqliteStore(path, key=KEY)
