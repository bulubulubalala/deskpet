<#
.SYNOPSIS
  一键产出 Windows 便携 zip 与 NSIS 安装包（v0.1 测试版）。

.DESCRIPTION
  顺序：pnpm build（esbuild 打 dist/）→ build_sidecar.ps1（PyInstaller onedir）→ electron-builder。
  两条前置必须都在 Windows 侧、用项目自己的环境跑（PyInstaller 不能交叉打包）。

  产物在 release/：
    deskpet-<版本>-x64.zip          便携包：解压后根目录直接双击 deskpet.exe
    deskpet-<版本>-x64-setup.exe    安装包：双击按向导安装
  包内会把 sidecar onedir 放到 resources\sidecar\（asar 之外）。

.NOTES
  国内网络：electron-builder 首次运行要从 GitHub 拉 Electron / 7zip 等构建依赖，
  建议先设好镜像（见 README「开发环境准备」）：
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
#>
param(
    [switch]$SkipSidecar
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Output "[1/4] esbuild 打包前端与主进程"
& pnpm.cmd build
if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败，退出码 $LASTEXITCODE" }

if (-not $SkipSidecar) {
    Write-Output "[2/4] PyInstaller 打包 sidecar"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build_sidecar.ps1")
    if ($LASTEXITCODE -ne 0) { throw "build_sidecar.ps1 失败，退出码 $LASTEXITCODE" }
} else {
    Write-Output "[2/4] 跳过 sidecar（-SkipSidecar）"
}

$sidecarExe = Join-Path $root "dist\sidecar\sidecar.exe"
if (-not (Test-Path $sidecarExe)) {
    throw "缺少 $sidecarExe：发布包里必须有 sidecar，先跑 scripts\build_sidecar.ps1"
}

Write-Output "[3/4] electron-builder 生成便携 zip 与安装包"
& pnpm.cmd exec electron-builder --win --x64
if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败，退出码 $LASTEXITCODE" }

Write-Output "[4/4] 生成 SHA256SUMS.txt 与发布清单"
& node (Join-Path $PSScriptRoot "release_manifest.mjs")
if ($LASTEXITCODE -ne 0) { throw "release_manifest.mjs 失败，退出码 $LASTEXITCODE" }

Get-ChildItem (Join-Path $root "release") -File |
    Where-Object { $_.Extension -eq ".zip" -or ($_.Extension -eq ".exe" -and $_.Name -like "deskpet-*-setup.exe") } |
    ForEach-Object { Write-Output ("产物：" + $_.Name + "  " + [math]::Round($_.Length / 1MB, 1) + " MB") }
