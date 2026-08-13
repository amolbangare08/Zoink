<#
.SYNOPSIS
    Installs ZOINK! into Premiere Pro as an unsigned development extension.

.DESCRIPTION
    Two things are needed to run an unsigned CEP extension:
      1. PlayerDebugMode must be set for every CSXS version Premiere might use.
      2. The extension must live in a folder Premiere scans.

    This script sets the registry flags under HKCU (no admin rights needed) and
    creates a directory junction from the per-user extensions folder back to this
    repository, so edits show up on the next panel reload instead of needing a
    reinstall.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-dev.ps1
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionId = 'com.zoink.premierepro.panel'
$extensionsDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$linkPath = Join-Path $extensionsDir $extensionId

Write-Host "ZOINK! development install" -ForegroundColor Magenta
Write-Host "  source: $repoRoot"
Write-Host "  target: $linkPath"
Write-Host ''

# 1. Allow unsigned extensions. Premiere picks a CSXS version by release, so set
#    the flag for every version that could plausibly load this panel.
foreach ($version in 9..12) {
    $key = "HKCU:\Software\Adobe\CSXS.$version"
    if (-not (Test-Path $key)) {
        New-Item -Path $key -Force | Out-Null
    }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
    Write-Host "  PlayerDebugMode set for CSXS.$version" -ForegroundColor DarkGray
}

# 2. Link the repo into the per-user extensions folder.
if (-not (Test-Path $extensionsDir)) {
    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
}

if (Test-Path $linkPath) {
    $existing = Get-Item $linkPath -Force
    if ($existing.LinkType) {
        Remove-Item $linkPath -Force
        Write-Host '  removed the previous link' -ForegroundColor DarkGray
    }
    else {
        throw "$linkPath already exists as a real folder. Move or delete it first."
    }
}

# A junction works without administrator rights or Developer Mode, unlike a symlink.
New-Item -ItemType Junction -Path $linkPath -Target $repoRoot | Out-Null

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host 'Restart Premiere Pro, then open Window > Extensions > ZOINK!'
Write-Host 'Panel debugger: http://localhost:8088 while the panel is open.'
