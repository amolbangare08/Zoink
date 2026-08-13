<#
.SYNOPSIS
    Packages ZOINK! into a signed .zxp for distribution.

.DESCRIPTION
    Requires ZXPSignCmd from the Adobe CEP resources repository:
      https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD

    A self-signed certificate is enough for installation through the ZXP Installer
    or Anastasiy's Extension Manager. Distribution through Adobe Exchange needs a
    real code-signing certificate instead.

.PARAMETER SignCmd
    Path to ZXPSignCmd.exe.

.PARAMETER Password
    Password protecting the .p12 certificate. One is generated on first run.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\package-zxp.ps1 -SignCmd C:\tools\ZXPSignCmd.exe -Password zoink
#>

param(
    [Parameter(Mandatory = $true)][string]$SignCmd,
    [Parameter(Mandatory = $true)][string]$Password
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$staging = Join-Path $distDir 'staging'
$certPath = Join-Path $distDir 'zoink-selfsigned.p12'
$zxpPath = Join-Path $distDir 'ZOINK.zxp'

if (-not (Test-Path $SignCmd)) {
    throw "ZXPSignCmd not found at $SignCmd"
}

# Staging copy so build artefacts and VCS metadata never reach the package.
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$include = @('CSXS', 'client', 'host', 'assets', 'bin')
foreach ($folder in $include) {
    $source = Join-Path $repoRoot $folder
    if (Test-Path $source) {
        Copy-Item $source -Destination $staging -Recurse -Force
    }
}

if (-not (Test-Path $certPath)) {
    Write-Host 'Creating a self-signed certificate…' -ForegroundColor DarkGray
    & $SignCmd -selfSignedCert US CA ZOINK ZOINK $Password $certPath
    if ($LASTEXITCODE -ne 0) { throw 'Certificate creation failed.' }
}

if (Test-Path $zxpPath) { Remove-Item $zxpPath -Force }

Write-Host 'Signing…' -ForegroundColor DarkGray
& $SignCmd -sign $staging $zxpPath $certPath $Password -tsa http://timestamp.digicert.com
if ($LASTEXITCODE -ne 0) { throw 'Signing failed.' }

& $SignCmd -verify $zxpPath -certinfo
Remove-Item $staging -Recurse -Force

Write-Host ''
Write-Host "Packaged: $zxpPath" -ForegroundColor Green
