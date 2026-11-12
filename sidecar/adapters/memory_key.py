"""文件职责：记忆库密钥的生成与保管（需求 §6.5）。

- 32 字节随机密钥，用当前 Windows 用户的 DPAPI 加密后写 <数据目录>/key.blob；
- 文件格式：magic b"DPK1" + 1 字节版本 + DPAPI 密文（换用户 / 换机器读不回来，这是有意的）；
- 读不出来一律抛 MemoryKeyInvalidError，服务层据此给 DP-MEM-001 与排查指引。
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from adapters import dpapi
from core.memory import MemoryKeyInvalidError

#: 文件头：便于日后换保护方式时识别
KEY_BLOB_MAGIC = b"DPK1"
KEY_BLOB_VERSION = 1
KEY_SIZE = 32


class KeyProtector(Protocol):
    """密钥保护器（生产用 DPAPI；测试注入替身，避免依赖当前用户配置）。"""

    def protect(self, data: bytes) -> bytes:
        """加密密钥字节。"""
        ...

    def unprotect(self, blob: bytes) -> bytes:
        """解密密钥字节。"""
        ...


class DpapiProtector:
    """默认保护器：当前用户 DPAPI。"""

    def protect(self, data: bytes) -> bytes:
        return dpapi.protect(data)

    def unprotect(self, blob: bytes) -> bytes:
        return dpapi.unprotect(blob)


def default_protector() -> KeyProtector:
    """生产用保护器；DPAPI 不可用时直接抛错，绝不退化到明文。"""
    if not dpapi.is_available():
        raise MemoryKeyInvalidError("记忆库密钥需要 Windows DPAPI，当前系统不支持")
    return DpapiProtector()


def read_key(path: Path, *, protector: KeyProtector | None = None) -> bytes | None:
    """读取密钥；文件不存在返回 None，存在但读不出来抛 MemoryKeyInvalidError。"""
    if not path.exists():
        return None
    raw = path.read_bytes()
    if len(raw) < len(KEY_BLOB_MAGIC) + 1 or raw[: len(KEY_BLOB_MAGIC)] != KEY_BLOB_MAGIC:
        raise MemoryKeyInvalidError(f"密钥文件损坏（文件头不对）：{path}")
    version = raw[len(KEY_BLOB_MAGIC)]
    if version != KEY_BLOB_VERSION:
        raise MemoryKeyInvalidError(f"密钥文件版本 {version} 不被支持：{path}")
    active = protector or default_protector()
    try:
        key = active.unprotect(raw[len(KEY_BLOB_MAGIC) + 1 :])
    except MemoryKeyInvalidError:
        raise
    except Exception as exc:
        raise MemoryKeyInvalidError(f"密钥解不开（换过 Windows 用户或换过机器？）：{exc}") from exc
    if len(key) != KEY_SIZE:
        raise MemoryKeyInvalidError(f"密钥长度不对（期望 {KEY_SIZE} 字节，实际 {len(key)}）")
    return key


def write_key(path: Path, key: bytes, *, protector: KeyProtector | None = None) -> None:
    """把密钥保护后写盘（先写临时文件再替换，避免半个文件）。"""
    if len(key) != KEY_SIZE:
        raise MemoryKeyInvalidError(f"密钥必须是 {KEY_SIZE} 字节，收到 {len(key)} 字节")
    active = protector or default_protector()
    payload = KEY_BLOB_MAGIC + bytes([KEY_BLOB_VERSION]) + active.protect(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def load_or_create_key(
    path: Path,
    *,
    protector: KeyProtector | None = None,
    random_bytes: Callable[[int], bytes] = os.urandom,
) -> bytes:
    """读取密钥，不存在就生成一个并写盘（首次启动才会走到生成分支）。"""
    existing = read_key(path, protector=protector)
    if existing is not None:
        return existing
    key = random_bytes(KEY_SIZE)
    write_key(path, key, protector=protector)
    return key


__all__ = [
    "KEY_BLOB_MAGIC",
    "KEY_BLOB_VERSION",
    "KEY_SIZE",
    "DpapiProtector",
    "KeyProtector",
    "default_protector",
    "load_or_create_key",
    "read_key",
    "write_key",
]
