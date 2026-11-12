<#
.SYNOPSIS
  给 Windows 产物打本地自签名（D6），并导出可分发/可安装的证书。

.DESCRIPTION
  为什么是自签名：真实 OV/EV 证书要公司主体与年费，本项目当前是个人分发。
  自签名不能消除 SmartScreen 的「未知发布者」首次提示（那要靠下载量与证书声誉），
  但它让「这个 exe 是不是我发的那一份」变得可核对——用同一张证书签的所有版本，
  证书指纹一致；把导出的 .cer 装进「受信任的根证书颁发机构」后，属性页也不再是红色。

  脚本只做三件事：
    1. 找证书：用 -Thumbprint 指定的；没有就用主题 CN=deskpet self-signed 的；再没有就新建一张；
    2. 用 signtool 给 release\win-unpacked 下的 exe 逐个签名（默认 SHA256 + 时间戳）；
    3. 导出证书到 release\deskpet-selfsigned.cer，并打印指纹与需要用户记住的两句话。

  必须 Windows 侧跑：signtool 属于 Windows SDK，签名本身也依赖 Windows 的证书存储。

.PARAMETER Target
  要签的目录，默认 release\win-unpacked（electron-builder 的产物）。

.PARAMETER Thumbprint
  指定证书指纹。不给则自动找 / 新建。

.PARAMETER CertSubject
  自动找或新建证书用的主题，默认 CN=deskpet self-signed。

.PARAMETER TimestampUrl
  时间戳服务地址。给空串则不打时间戳（离线构建用）。

.PARAMETER NoTimestamp
  完全不尝试时间戳。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sign_windows.ps1

.EXAMPLE
  pnpm sign:win
#>
param(
    [string]$Target = "release/win-unpacked",
    [string]$Thumbprint = "",
    [string]$CertSubject = "CN=deskpet self-signed",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [switch]$NoTimestamp
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Resolve-SignTool {
    if ($env:DESKPET_SIGNTOOL -and (Test-Path $env:DESKPET_SIGNTOOL)) {
        return $env:DESKPET_SIGNTOOL
    }
    $roots = @()
    if (${env:ProgramFiles(x86)}) { $roots += Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin" }
    if ($env:ProgramFiles) { $roots += Join-Path $env:ProgramFiles "Windows Kits\10\bin" }
    $found = @()
    foreach ($base in $roots) {
        if (-not (Test-Path $base)) { continue }
        $found += Get-ChildItem -Path $base -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" }
    }
    if ($found.Count -eq 0) {
        throw "找不到 signtool.exe：请安装 Windows SDK（或设置 DESKPET_SIGNTOOL 指向它）。"
    }
    # 目录名是 SDK 版本号，按版本倒序取最新的一份
    return ($found | Sort-Object -Property FullName -Descending | Select-Object -First 1).FullName
}

function Resolve-SigningCert {
    if ($Thumbprint -ne "") {
        $wanted = ($Thumbprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
        $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $wanted } | Select-Object -First 1
        if (-not $cert) { throw "证书存储里找不到指纹为 $Thumbprint 的证书（CurrentUser\My）。" }
        return $cert
    }
    $existing = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $CertSubject -and $_.HasPrivateKey } |
        Sort-Object -Property NotAfter -Descending |
        Select-Object -First 1
    if ($existing) { return $existing }
    Write-Host "没有现成证书，新建一张自签名代码签名证书：$CertSubject（有效期 3 年）" -ForegroundColor Yellow
    return New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $CertSubject `
        -FriendlyName "deskpet self-signed (local)" `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyUsage DigitalSignature `
        -NotAfter (Get-Date).AddYears(3) `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
}

$signTarget = Join-Path $root $Target
if (-not (Test-Path $signTarget)) {
    throw "找不到要签名的目录：$signTarget（先跑 pnpm pack:win）"
}

$signtool = Resolve-SignTool
$cert = Resolve-SigningCert
Write-Host "签名证书：$($cert.Subject)  指纹 $($cert.Thumbprint)" -ForegroundColor Cyan

# 只签 exe：dll 由 Electron 自带的签名（官方构建）覆盖，重签反而会破坏它
$signables = @(Get-ChildItem -Path $signTarget -Recurse -Filter "*.exe" | Sort-Object -Property FullName)
if ($signables.Count -eq 0) { throw "目录里没有 exe：$signTarget" }

function Get-RelativePath([string]$base, [string]$full) {
    # 去掉基准目录与前导分隔符，报告里给人看的短路径
    return $full.Substring($base.Length) -replace '^[\\/]+', ''
}

$failed = @()
$signed = @()
foreach ($file in $signables) {
    $relative = Get-RelativePath $signTarget $file.FullName
    $arguments = @("sign", "/sha1", $cert.Thumbprint, "/fd", "SHA256", "/v")
    if (-not $NoTimestamp -and $TimestampUrl -ne "") {
        $arguments += @("/tr", $TimestampUrl, "/td", "SHA256")
    }
    $arguments += $file.FullName
    & $signtool @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        if (-not $NoTimestamp -and $TimestampUrl -ne "") {
            Write-Host "  时间戳失败，改为不带时间戳重试：$relative" -ForegroundColor Yellow
            $retry = @("sign", "/sha1", $cert.Thumbprint, "/fd", "SHA256", "/v", $file.FullName)
            & $signtool @retry | Out-Null
        }
        if ($LASTEXITCODE -ne 0) {
            $failed += $relative
            Write-Host "  失败：$relative" -ForegroundColor Red
            continue
        }
    }
    $signed += $relative
    Write-Host "  已签：$relative" -ForegroundColor Green
}

$cerPath = Join-Path $root "release\deskpet-selfsigned.cer"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cerPath) | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Write-Host "证书已导出：$cerPath" -ForegroundColor Cyan

# 自签名证书不在受信任根里，Get-AuthenticodeSignature 会报 UnknownError——这里只核对「签名在里面」
$unsigned = @()
foreach ($file in $signables) {
    $status = Get-AuthenticodeSignature -FilePath $file.FullName
    if ($null -eq $status.SignerCertificate) {
        $unsigned += Get-RelativePath $signTarget $file.FullName
    }
}
$failed += $unsigned

Write-Host ""
Write-Host "已签 $($signed.Count) 个文件，失败 $($failed.Count) 个。" -ForegroundColor Cyan
Write-Host "证书指纹（发版说明里要写）：$($cert.Thumbprint)"
Write-Host "用户想消除红色提示：双击 $cerPath → 安装证书 → 本地计算机 → 受信任的根证书颁发机构。"
if ($failed.Count -gt 0) {
    $failed | ForEach-Object { Write-Host "  未签上：$_" -ForegroundColor Red }
    exit 1
}
