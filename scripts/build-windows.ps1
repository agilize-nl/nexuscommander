[CmdletBinding()]
param(
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Require-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is niet gevonden. Volg apps/desktop/docs/WINDOWS_INSTALL.md en open daarna een nieuwe PowerShell."
    }
}

Require-Command node
Require-Command npm
Require-Command cargo
Require-Command rustc

if (-not $SkipChecks) {
    Write-Host 'Node-, Rust- en projectcontroles uitvoeren...'
    & npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & npm run check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host 'Windows NSIS-installer bouwen...'
& npm run build:windows
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$installerDirectory = Join-Path $repoRoot 'apps\desktop\src-tauri\target\release\bundle\nsis'
$installer = Get-ChildItem -LiteralPath $installerDirectory -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "Build is voltooid, maar geen NSIS-installer gevonden in $installerDirectory."
}

Write-Host ''
Write-Host "Klaar. Installeer met: $($installer.FullName)" -ForegroundColor Green
