<#
.SYNOPSIS
  一键产出 Windows 发布物（T0.9）：electron-builder 的 NSIS 安装包 + 免安装 zip。

.DESCRIPTION
  顺序：pnpm build（esbuild 打 dist/）→ build_sidecar.ps1（PyInstaller onedir）→ electron-builder。
  两条前置必须都在 Windows 侧、用项目自己的环境跑（PyInstaller 不能交叉打包）。

  产物在 release/：
    deskpet-<版本>-x64.exe   NSIS 安装包（可选安装目录、建桌面与开始菜单快捷方式）
    deskpet-<版本>-x64.zip   免安装包（解压即用）
  两者内部都会把 sidecar onedir 放到 resources\sidecar\（asar 之外）。

.NOTES
  国内网络：electron-builder 首次运行要从 GitHub 拉 NSIS / winCodeSign 二进制，
  建议先设好镜像（见 README「开发环境准备」）：
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
#>
param(
    [switch]$SkipSidecar
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "[1/3] esbuild 打包前端与主进程"
& pnpm.cmd build
if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败，退出码 $LASTEXITCODE" }

if (-not $SkipSidecar) {
    Write-Output "[2/3] PyInstaller 打包 sidecar"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build_sidecar.ps1")
    if ($LASTEXITCODE -ne 0) { throw "build_sidecar.ps1 失败，退出码 $LASTEXITCODE" }
} else {
    Write-Output "[2/3] 跳过 sidecar（-SkipSidecar）"
}

$sidecarExe = Join-Path $root "dist\sidecar\sidecar.exe"
if (-not (Test-Path $sidecarExe)) {
    throw "缺少 $sidecarExe：发布包里必须有 sidecar，先跑 scripts\build_sidecar.ps1"
}

Write-Output "[3/3] electron-builder 产出安装包与免安装包"
& pnpm.cmd exec electron-builder --win --x64
if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败，退出码 $LASTEXITCODE" }

Get-ChildItem (Join-Path $root "release") -File |
    Where-Object { $_.Extension -in @(".exe", ".zip") } |
    ForEach-Object { Write-Output ("产物：" + $_.Name + "  " + [math]::Round($_.Length / 1MB, 1) + " MB") }
