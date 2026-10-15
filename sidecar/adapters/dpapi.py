"""文件职责：Windows DPAPI 的最小封装（需求 §6.5：记忆库密钥绑定当前用户）。

依赖方向：只用标准库 ctypes；不 import 任何业务模块。
谁调用：adapters.memory_key 用它保护 key.blob；非 Windows 上 is_available() 为 False。
为什么不用 pywin32：为了一个函数引入一个几百 MB 的依赖不划算，ctypes 足够。
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from typing import Any

#: 不弹任何 UI（后台进程没有窗口可弹）
CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DataBlob(ctypes.Structure):
    """crypt32 的 DATA_BLOB。"""

    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def is_available() -> bool:
    """当前环境有没有 DPAPI（只有 Windows 有）。"""
    return os.name == "nt"


def _crypt32() -> Any:
    library = ctypes.WinDLL("crypt32.dll", use_last_error=True)
    library.CryptProtectData.argtypes = [
        ctypes.POINTER(DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    library.CryptProtectData.restype = wintypes.BOOL
    library.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    library.CryptUnprotectData.restype = wintypes.BOOL
    return library


def _kernel32() -> Any:
    library = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    library.LocalFree.argtypes = [ctypes.c_void_p]
    library.LocalFree.restype = ctypes.c_void_p
    return library


def _blob(data: bytes) -> tuple[Any, DataBlob]:
    """把 bytes 变成 DATA_BLOB；返回缓冲区本身，调用方必须持有它直到调用结束。"""
    buffer = ctypes.create_string_buffer(data)
    return buffer, DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))


def _take(result: DataBlob) -> bytes:
    """把出参 DATA_BLOB 拷成 bytes 并释放 crypt32 分配的内存。"""
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        if result.pbData:
            _kernel32().LocalFree(ctypes.cast(result.pbData, ctypes.c_void_p))


def protect(data: bytes, *, entropy: bytes = b"") -> bytes:
    """用当前用户的 DPAPI 加密（只有同一用户在同一台机器上能解开）。"""
    library = _crypt32()
    # 元组解包会把缓冲区绑定在局部变量上，DPAPI 调用期间它一直有效（不能提前释放）
    _data_buffer, data_blob = _blob(data)
    _entropy_buffer, entropy_blob = _blob(entropy)
    out = DataBlob()
    ok = library.CryptProtectData(
        ctypes.byref(data_blob),
        None,
        ctypes.byref(entropy_blob),
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out),
    )
    if not ok:
        raise OSError(ctypes.get_last_error(), "CryptProtectData 失败")
    return _take(out)


def unprotect(blob: bytes, *, entropy: bytes = b"") -> bytes:
    """解开 DPAPI 密文；换用户 / 换机器 / 文件被改过都会失败。"""
    library = _crypt32()
    _blob_buffer, blob_data = _blob(blob)
    _entropy_buffer, entropy_blob = _blob(entropy)
    out = DataBlob()
    ok = library.CryptUnprotectData(
        ctypes.byref(blob_data),
        None,
        ctypes.byref(entropy_blob),
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out),
    )
    if not ok:
        raise OSError(ctypes.get_last_error(), "CryptUnprotectData 失败")
    return _take(out)


__all__ = ["DataBlob", "is_available", "protect", "unprotect"]
