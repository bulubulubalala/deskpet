<#
.SYNOPSIS
  打包 Python sidecar 为 PyInstaller onedir 产物（T0.8）。

.DESCRIPTION
  产物：dist/sidecar/sidecar.exe（整目录一起分发）。
  必须在 Windows 侧、用项目自己的 .venv 跑：跨平台的 PyInstaller 不能交叉打包，
  而且仓库要求「每个项目独立环境」（不改系统 Python）。

.PARAMETER Clean
  先删掉 build/pyinstaller 与 dist/sidecar 再打包。CI 与「改了依赖后」建议带上。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_sidecar.ps1 -Clean
#>
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "找不到项目独立环境：$python（见 README「开发环境准备」第 2-3 步）"
}

$spec = Join-Path $root "sidecar\sidecar.spec"
$distPath = Join-Path $root "dist"
$workPath = Join-Path $root "build\pyinstaller"

if ($Clean) {
    Remove-Item -Recurse -Force $workPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $distPath "sidecar") -ErrorAction SilentlyContinue
}

& $python -m PyInstaller --noconfirm --clean --distpath $distPath --workpath $workPath $spec
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller 失败，退出码 $LASTEXITCODE"
}

$exe = Join-Path $distPath "sidecar\sidecar.exe"
if (-not (Test-Path $exe)) {
    throw "没有产出 $exe"
}

$sizeMb = [math]::Round(((Get-ChildItem -Recurse -File (Join-Path $distPath "sidecar") |
    Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Output "构建完成：$exe（整目录 $sizeMb MB，需整体分发）"
