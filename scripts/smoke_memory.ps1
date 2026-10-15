# 文件职责：记忆链路冒烟的一键入口——用同一个数据目录起两次真实 Electron：
# 第一次发一句带事实的话（核对 sidecar 的 GET /memory/list 里有这条事实），收掉进程后再起第二次问刚说过的名字。
# 前置：pnpm build 已产出 dist/、仓库根有 .env（LLM 端点），node 在 PATH 上。
# 台词与断言关键词写在 scripts/smoke_memory.mjs 里（避开中文经由 Windows 命令行的转码问题）。
# 不传 -DataDir 时每次用随机临时目录，绝不会拿上一次遗留的记忆冒充本次写入。
param(
  [int]$Port = 9224,
  [string]$DataDir = '',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$freshDir = [string]::IsNullOrWhiteSpace($DataDir)
if ($freshDir) {
  $DataDir = Join-Path $env:TEMP ('deskpet-smoke-memory-' + (Get-Random))
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  throw "electron.exe not found: $electron (run pnpm install first)"
}
$driver = Join-Path $root 'scripts\smoke_memory.mjs'
$oldData = $env:DESKPET_DATA_DIR
$env:DESKPET_DATA_DIR = $DataDir

function Stop-Electron {
  param($Process)
  if ($null -ne $Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
  }
}

$tellProc = $null
$askProc = $null
$exitCode = 1
try {
  Write-Output '--- stage tell: 写一条事实 ---'
  $tellProc = Start-Process -FilePath $electron -ArgumentList '.', ('--remote-debugging-port=' + $Port) -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 3
  $tellOut = & node $driver --stage tell --port $Port --data-dir $DataDir
  $tellCode = $LASTEXITCODE
  Write-Output ('TELL_EXIT=' + $tellCode)
  Write-Output ('TELL=' + (($tellOut | Out-String).Trim()))
  Stop-Electron $tellProc
  $tellProc = $null
  # 等端口与 sidecar 释放干净，避免第二次实例连上第一个 sidecar
  Start-Sleep -Seconds 3

  Write-Output '--- stage ask: 重启后问名字 ---'
  $askProc = Start-Process -FilePath $electron -ArgumentList '.', ('--remote-debugging-port=' + $Port) -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 3
  $askOut = & node $driver --stage ask --port $Port --data-dir $DataDir
  $askCode = $LASTEXITCODE
  Write-Output ('ASK_EXIT=' + $askCode)
  Write-Output ('ASK=' + (($askOut | Out-String).Trim()))

  if ($tellCode -eq 0 -and $askCode -eq 0) {
    $exitCode = 0
  }
} finally {
  Stop-Electron $tellProc
  Stop-Electron $askProc
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
