# 文件职责：设置窗冒烟的一键入口——先用对话链路造一条事实，再重开应用驱动设置窗（scripts/smoke_settings.mjs），
# 核对「模型供给」三张卡片与「测试连接」，以及「记忆与统计」的删除 / 两次确认清空。
# 前置：pnpm build 已产出 dist/、仓库根有 .env（LLM 端点）、node 在 PATH 上。
# 不传 -DataDir 时用随机临时目录，避免拿上一次遗留的记忆冒充本次写入。
param(
  [int]$Port = 9225,
  [string]$DataDir = '',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$freshDir = [string]::IsNullOrWhiteSpace($DataDir)
if ($freshDir) {
  $DataDir = Join-Path $env:TEMP ('deskpet-smoke-settings-' + (Get-Random))
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  throw ('electron.exe not found: ' + $electron + ' (run pnpm install first)')
}
$memoryDriver = Join-Path $root 'scripts\smoke_memory.mjs'
$settingsDriver = Join-Path $root 'scripts\smoke_settings.mjs'
$oldData = $env:DESKPET_DATA_DIR
$env:DESKPET_DATA_DIR = $DataDir
$tellProc = $null
$settingsProc = $null
$exitCode = 1

function Stop-Electron {
  param($Process)
  if ($null -ne $Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
  }
}

# 兜底清扫：主进程没被 taskkill 收干净时会占着单实例锁，
# 下一次冒烟的新实例会静默自退（进程都没有，CDP 端口自然连不上——真机踩过）。
function Stop-RepoProcesses {
  $targets = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe' or Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like ('*' + $root + '*') }
  foreach ($target in $targets) {
    & taskkill.exe /PID $target.ProcessId /T /F | Out-Null
  }
}

try {
  Stop-RepoProcesses
  # dist/ 会在源码改动后悄悄过期（设置窗的 HTML 也是构建产物），先重建再起应用。
  Write-Output '--- stage build: 让 dist/ 跟上 app/ 源码 ---'
  & node (Join-Path $root 'scripts\build.mjs')
  if ($LASTEXITCODE -ne 0) {
    throw 'build failed'
  }

  Write-Output '--- stage tell: 先让记忆里有东西 ---'
  $tellProc = Start-Process -FilePath $electron -ArgumentList '.', ('--remote-debugging-port=' + $Port) -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 3
  $tellOut = & node $memoryDriver --stage tell --port $Port --data-dir $DataDir
  $tellCode = $LASTEXITCODE
  Write-Output ('TELL_EXIT=' + $tellCode)
  Write-Output ('TELL=' + (($tellOut | Out-String).Trim()))
  Stop-Electron $tellProc
  $tellProc = $null
  Start-Sleep -Seconds 3

  Write-Output '--- stage settings: 重开应用验设置窗 ---'
  $settingsProc = Start-Process -FilePath $electron -ArgumentList '.', ('--remote-debugging-port=' + $Port) -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 3
  $settingsOut = & node $settingsDriver --port $Port
  $settingsCode = $LASTEXITCODE
  Write-Output ('SETTINGS_EXIT=' + $settingsCode)
  Write-Output ('SETTINGS=' + (($settingsOut | Out-String).Trim()))

  if ($tellCode -eq 0 -and $settingsCode -eq 0) {
    $exitCode = 0
  }
} finally {
  Stop-Electron $tellProc
  Stop-Electron $settingsProc
  Stop-RepoProcesses
  if ($null -eq $oldData) {
    Remove-Item Env:\DESKPET_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:DESKPET_DATA_DIR = $oldData
  }
  Write-Output ('DATA_DIR=' + $DataDir)
  if ($Clean -and $freshDir) {
    Remove-Item -Recurse -Force -Path $DataDir -ErrorAction SilentlyContinue
  }
}
exit $exitCode
