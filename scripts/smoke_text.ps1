# 文件职责：文字链路冒烟的一键入口——起真实 Electron（临时数据目录 + CDP 端口），
# 跑 scripts/smoke_text.mjs 连续 3 轮对话（第 2 轮中途打断），最后无论成败都收掉进程。
# 前置：pnpm build 已产出 dist/、仓库根有 .env（LLM 端点），node 在 PATH 上。
param(
  [int]$Port = 9223,
  [int]$Turns = 3,
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $env:TEMP ('deskpet-smoke-text-' + (Get-Random))
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  throw "electron.exe not found: $electron (run pnpm install first)"
}
$driver = Join-Path $root 'scripts\smoke_text.mjs'
$oldData = $env:DESKPET_DATA_DIR
$env:DESKPET_DATA_DIR = $DataDir
$proc = $null
$exitCode = 1
try {
  $proc = Start-Process -FilePath $electron -ArgumentList '.', ('--remote-debugging-port=' + $Port) -WorkingDirectory $root -PassThru
  Start-Sleep -Seconds 3
  & node $driver --port $Port --turns $Turns
  $exitCode = $LASTEXITCODE
} finally {
  if ($null -ne $proc -and -not $proc.HasExited) {
    & taskkill.exe /PID $proc.Id /T /F | Out-Null
  }
  if ($null -eq $oldData) {
    Remove-Item Env:\DESKPET_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:DESKPET_DATA_DIR = $oldData
  }
  Write-Output ('DATA_DIR=' + $DataDir)
}
exit $exitCode
