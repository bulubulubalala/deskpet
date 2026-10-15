"""文件职责：记忆库密钥的生成、保管与损坏检测（需求 §6.5；PLAN T2.1a）。

依赖方向：tests -> adapters.memory_key / core.memory；注入替身保护器，**不依赖 Windows DPAPI**，
所以这套用例在任何平台都能跑（真实 DPAPI 只由 tools 下的探测脚本验证）。
谁调用：pytest。
"""

from pathlib import Path

import pytest

from adapters.memory_key import (
    KEY_BLOB_MAGIC,
    KEY_BLOB_VERSION,
    KEY_SIZE,
    load_or_create_key,
    read_key,
    write_key,
)
from core.memory import MemoryKeyInvalidError


class FakeProtector:
    """可复现的假保护器：逐字节异或。

    换个 mask 就解不开——用来模拟「换了 Windows 用户 / 换了机器」这种真实故障，
    而不必真的去碰 DPAPI。
    """

    def __init__(self, mask: int = 0x5A) -> None:
        self._mask = mask

    #: 明文前 4 字节放 mask 标签：真 DPAPI 解不开时会抛异常，替身也要能「验出解错」
    _TAG_SIZE = 4

    def protect(self, data: bytes) -> bytes:
        return bytes([self._mask]) * self._TAG_SIZE + bytes(byte ^ self._mask for byte in data)

    def unprotect(self, blob: bytes) -> bytes:
        tag = bytes([self._mask]) * self._TAG_SIZE
        if blob[: self._TAG_SIZE] != tag:
            raise OSError("假保护器解不开：mask 不匹配（模拟换了 Windows 用户）")
        return bytes(byte ^ self._mask for byte in blob[self._TAG_SIZE :])


def test_read_key_returns_none_when_file_missing(tmp_path: Path) -> None:
    """首次启动没有密钥文件：返回 None 而不是报错，生成交给 load_or_create_key。"""
    assert read_key(tmp_path / "key.blob", protector=FakeProtector()) is None


def test_write_then_read_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "key.blob"
    key = bytes(range(1, KEY_SIZE + 1))
    write_key(path, key, protector=FakeProtector(mask=0x33))
    assert read_key(path, protector=FakeProtector(mask=0x33)) == key


def test_key_file_never_contains_plaintext(tmp_path: Path) -> None:
    """落盘的一定是「魔数 + 版本 + 密文」：在文件里找得到密钥原文就是严重缺陷。"""
    path = tmp_path / "key.blob"
    key = bytes([0x41] * KEY_SIZE)
    write_key(path, key, protector=FakeProtector(mask=0xFF))
    raw = path.read_bytes()
    assert raw[: len(KEY_BLOB_MAGIC)] == KEY_BLOB_MAGIC
    assert raw[len(KEY_BLOB_MAGIC)] == KEY_BLOB_VERSION
    assert key not in raw


def test_write_key_rejects_wrong_length(tmp_path: Path) -> None:
    """密钥长度必须在写盘前就卡住，不能写进去半个密钥。"""
    with pytest.raises(MemoryKeyInvalidError):
        write_key(tmp_path / "key.blob", b"short", protector=FakeProtector())


def test_wrong_protector_is_reported_as_key_invalid(tmp_path: Path) -> None:
    """换用户 / 换机器后 DPAPI 解不开：必须是 MemoryKeyInvalidError（对应 DP-MEM-001）。"""
    path = tmp_path / "key.blob"
    write_key(path, bytes(range(1, KEY_SIZE + 1)), protector=FakeProtector(mask=0x11))
    with pytest.raises(MemoryKeyInvalidError):
        read_key(path, protector=FakeProtector(mask=0x22))


def test_broken_header_is_reported_as_key_invalid(tmp_path: Path) -> None:
    path = tmp_path / "key.blob"
    path.write_bytes(b"XXXX" + bytes([KEY_BLOB_VERSION]) + b"payload")
    with pytest.raises(MemoryKeyInvalidError):
        read_key(path, protector=FakeProtector())


def test_unsupported_version_is_reported_as_key_invalid(tmp_path: Path) -> None:
    path = tmp_path / "key.blob"
    path.write_bytes(KEY_BLOB_MAGIC + bytes([KEY_BLOB_VERSION + 1]) + b"payload")
    with pytest.raises(MemoryKeyInvalidError):
        read_key(path, protector=FakeProtector())


def test_decoded_length_must_be_exactly_key_size(tmp_path: Path) -> None:
    """解出来长度不对（文件被截断 / 被改过）也要报 DP-MEM-001，不能拿去开库。"""
    path = tmp_path / "key.blob"
    protector = FakeProtector()
    path.write_bytes(KEY_BLOB_MAGIC + bytes([KEY_BLOB_VERSION]) + protector.protect(b"x" * 8))
    with pytest.raises(MemoryKeyInvalidError):
        read_key(path, protector=protector)


def test_load_or_create_generates_once_then_reuses(tmp_path: Path) -> None:
    """第一次生成、第二次必须复用同一个密钥（否则每次启动都会读不了库）。"""
    path = tmp_path / "key.blob"
    calls: list[int] = []

    def random_bytes(count: int) -> bytes:
        calls.append(count)
        return bytes([0x07] * count)

    first = load_or_create_key(path, protector=FakeProtector(), random_bytes=random_bytes)
    second = load_or_create_key(path, protector=FakeProtector(), random_bytes=random_bytes)
    assert first == second == bytes([0x07] * KEY_SIZE)
    assert calls == [KEY_SIZE], "第二个应该命中已有密钥文件，不该再生成"
