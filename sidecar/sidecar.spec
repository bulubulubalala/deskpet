# -*- mode: python ; coding: utf-8 -*-
"""文件职责：PyInstaller onedir 打包配置（T0.8，需求 §9.3）。

依赖方向：只描述「哪些代码进包」，不 import 任何业务模块。
谁调用：scripts/build_sidecar.ps1 → .venv/Scripts/python.exe -m PyInstaller sidecar/sidecar.spec
产出：dist/sidecar/sidecar.exe（onedir：**整目录一起分发，不能只拷 exe**）。

为什么选 onedir 而不是 onefile（需求 §9.3）：
onefile 每次启动都要把整包解压到临时目录，冷启动多 1–3 秒、且更容易被杀软拦截；
sidecar 由 Electron 拉起并常驻，启动快与「坏了能翻文件排查」比单文件更重要。
"""

from pathlib import Path

SIDECAR_ROOT = Path(SPECPATH)  # noqa: F821 —— SPECPATH 由 PyInstaller 注入
PROJECT_ROOT = SIDECAR_ROOT.parent

# uvicorn 运行期用字符串动态 import 这些实现模块，静态分析看不到，必须显式声明；
# 漏一个的典型症状是「开发态好好的，打包后 import uvicorn 时报 ModuleNotFoundError」。
HIDDEN_IMPORTS = [
    "uvicorn.logging",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.auto",
    "uvicorn.lifespan.on",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
]

a = Analysis(  # noqa: F821
    [str(SIDECAR_ROOT / "main.py")],
    pathex=[str(SIDECAR_ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=HIDDEN_IMPORTS,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 这三个只在开发态用，进包只会让产物变大（打包机跑的是 .venv 里的它们，不是包里的）
    excludes=["pytest", "mypy", "ruff"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
