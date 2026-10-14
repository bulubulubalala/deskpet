#requires -Version 5.1
<#
.SYNOPSIS
  打包产物冒烟与冷启动实测（T0.12）。

.DESCRIPTION
  跑一次无人值守的打包应用启动，测三段可复现的数字：
    1) sidecar 单独冷启动 → /health 200
    2) 应用进程启动 → 主窗口可见
    3) 应用进程启动 → sidecar /health 200
  并打印安装包 / 解压目录 / sidecar 的体积。到点后走与托盘「退出」相同的收尾路径。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\smoke_release.ps1
#>
param(
  [string]$Exe = "",
  [int]$QuitAfterMs = 20000,
  [int]$TimeoutMs = 45000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $Exe) { $Exe = Join-Path $root "release\win-unpacked\deskpet.exe" }
if (-not [System.IO.Path]::IsPathRooted($Exe)) { $Exe = Join-Path $root $Exe }
$sidecarExe = Join-Path $root "release\win-unpacked\resources\sidecar\sidecar.exe"

function Get-DirSizeMB([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "N/A" }
  $b = (Get-ChildItem -LiteralPath $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum
  return [math]::Round($b / 1MB, 1)
}

function Get-FileSizeMB([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "N/A" }
  return [math]::Round((Get-Item -LiteralPath $Path).Length / 1MB, 1)
}

<# 轮询 runtime.json 并请求 /health，返回 @{ Ms; Port; Pid; Status }；超时则 Ms = -1。 #>
function Wait-Health([string]$DataDir, [int]$BudgetMs) {
  $runtimePath = Join-Path $DataDir "runtime.json"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $BudgetMs) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-Path -LiteralPath $runtimePath)) { continue }
    try { $rt = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json } catch { continue }
    if ($null -eq $rt -or -not $rt.port) { continue }
    try {
      $h = Invoke-RestMethod -Uri "http://$($rt.host):$($rt.port)/health" -Headers @{ "X-Deskpet-Token" = $rt.token } -TimeoutSec 3
      return @{ Ms = $sw.ElapsedMilliseconds; Port = $rt.port; Pid = $rt.pid; Status = $h.status; Uptime = $h.uptime_s }
    } catch { }
  }
  return @{ Ms = -1; Port = $null; Pid = $null; Status = $null; Uptime = $null }
}

if (-not (Test-Path -LiteralPath $Exe)) { throw "missing $Exe -- run scripts\build_release.ps1 first" }
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version

"== sizes (MB) =="
"nsis_exe      = $(Get-FileSizeMB (Join-Path $root "release\deskpet-$version-x64.exe"))"
"portable_zip  = $(Get-FileSizeMB (Join-Path $root "release\deskpet-$version-x64.zip"))"
"win_unpacked  = $(Get-DirSizeMB (Join-Path $root "release\win-unpacked"))"
"sidecar_dir   = $(Get-DirSizeMB (Join-Path $root "release\win-unpacked\resources\sidecar"))"
"app_exe       = $(Get-FileSizeMB $Exe)"

$tag = [guid]::NewGuid().ToString("N").Substring(0, 8)
$electronData = Join-Path $env:TEMP "deskpet-smoke-$tag"
New-Item -ItemType Directory -Force -Path $electronData | Out-Null

"== sidecar cold start (standalone, 跑两遍：第一遍冷、第二遍热) =="
if (Test-Path -LiteralPath $sidecarExe) {
  $env:DESKPET_SIDECAR_PORT = "8741"
  foreach ($round in 1, 2) {
    $sData = Join-Path $env:TEMP "deskpet-sidecar-$tag-$round"
    New-Item -ItemType Directory -Force -Path $sData | Out-Null
    $env:DESKPET_DATA_DIR = $sData
    $sProc = Start-Process -FilePath $sidecarExe -PassThru -WindowStyle Hidden
    $r = Wait-Health -DataDir $sData -BudgetMs 30000
    "sidecar_round$($round)_ms   = $($r.Ms)"
    "sidecar_round$($round)_port = $($r.Port)"
    taskkill /PID $sProc.Id /T /F 2>&1 | Out-Null
    Remove-Item -LiteralPath $sData -Recurse -Force -ErrorAction SilentlyContinue
  }
  $env:DESKPET_SIDECAR_PORT = $null
} else {
  "sidecar_cold_ms = N/A (missing $sidecarExe)"
}

"== packaged app =="
$env:DESKPET_DATA_DIR = $electronData
$env:DESKPET_SMOKE_QUIT_MS = "$QuitAfterMs"
"data_dir      = $electronData"
"quit_after_ms = $QuitAfterMs"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $Exe -PassThru

$windowMs = -1
$title = ""
while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
  Start-Sleep -Milliseconds 50
  if ($proc.HasExited) { break }
  $live = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($null -ne $live -and $live.MainWindowHandle -ne 0) {
    $windowMs = $sw.ElapsedMilliseconds
    $title = $live.MainWindowTitle
    break
  }
}
"window_ms     = $windowMs"
"window_title  = $title"

$r2 = Wait-Health -DataDir $electronData -BudgetMs ([math]::Max(1000, $TimeoutMs - $sw.ElapsedMilliseconds))
"health_from_launch_ms = $($sw.ElapsedMilliseconds)"
"sidecar_port  = $($r2.Port)"
"sidecar_pid   = $($r2.Pid)"
"health_status = $($r2.Status)"

$proc.WaitForExit($TimeoutMs) | Out-Null
"exited        = $($proc.HasExited)"
"runtime_left  = $(Test-Path -LiteralPath (Join-Path $electronData "runtime.json"))"
"orphan_sidecar= $(@(Get-Process -Name sidecar -ErrorAction SilentlyContinue).Count)"
"left_app      = $(@(Get-Process -Name deskpet -ErrorAction SilentlyContinue).Count)"
$mainLog = Join-Path $electronData "logs\deskpet-main.log"
if (Test-Path -LiteralPath $mainLog) {
  "smoke_logged  = $($null -ne (Select-String -LiteralPath $mainLog -Pattern "app.smoke_quit" -SimpleMatch))"
}
Remove-Item -LiteralPath $electronData -Recurse -Force -ErrorAction SilentlyContinue
"done"