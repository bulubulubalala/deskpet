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

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

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
    # 下面这些都在适配器里「延迟 import」（为了没装时也能起 /health）：静态分析看不到，
    # 不登记的话打包后会在第一次真正调用时报 ModuleNotFoundError。
    "faster_whisper",
    "edge_tts",
    "aiohttp",
    "sherpa_onnx",
    "sherpa_onnx.lib._sherpa_onnx",
    "numpy",
    # T2.14：原生麦克风兜底（sounddevice / PortAudio）
    "sounddevice",
    "_sounddevice_data",
    # F7：本地 OCR（rapidocr 在服务里延迟 import）
    "rapidocr",
]

# sherpa-onnx 的原生 DLL 是运行时由 .pyd 按相对路径加载的，PyInstaller 的静态依赖分析
# 不一定会带上；显式收集整个 lib 目录（onnxruntime.dll / c-api / cxx-api）。
# faster-whisper 的 VAD 资产（assets/silero_vad_v6.onnx）也是数据文件，漏了会在 /asr 500。
BINARIES = collect_dynamic_libs("sherpa_onnx") + collect_dynamic_libs("sounddevice")
DATAS = (
    collect_data_files("sherpa_onnx")
    + collect_data_files("faster_whisper")
    + collect_data_files("_sounddevice_data")
    + collect_data_files("rapidocr")
)

a = Analysis(  # noqa: F821
    [str(SIDECAR_ROOT / "main.py")],
    pathex=[str(SIDECAR_ROOT)],
    binaries=BINARIES,
    datas=DATAS,
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
