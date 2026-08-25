# --------------------------------------------------------------------------
# scripts/coverage.ps1
#
# Wrapper around `forge coverage` that always passes `--ir-minimum`, which is
# required to compile this project under coverage's optimizer-disabled mode
# (otherwise ToshFactory.sol hits "stack too deep").
#
# Usage:
#   ./scripts/coverage.ps1                       # summary table (default)
#   ./scripts/coverage.ps1 -Report lcov          # lcov.info for editors / CI
#   ./scripts/coverage.ps1 -Report debug         # per-line debug output
#   ./scripts/coverage.ps1 -ExtraArgs "--match-contract ToshFactory"
# --------------------------------------------------------------------------
[CmdletBinding()]
param(
    [ValidateSet('summary', 'lcov', 'debug')]
    [string]$Report = 'summary',

    [string]$ExtraArgs = ''
)

# PowerShell 5.1 treats anything a native binary writes to stderr as a
# "NativeCommandError" by default, which would make this wrapper exit 1 on the
# benign "--ir-minimum enables viaIR..." warning. `Continue` keeps the warning
# visible without turning it into a fatal terminator.
$ErrorActionPreference = 'Continue'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

$fullArgs = @('coverage', '--ir-minimum', '--report', $Report)
if (-not [string]::IsNullOrWhiteSpace($ExtraArgs)) {
    $fullArgs += ($ExtraArgs -split '\s+')
}

Write-Host "==> forge $($fullArgs -join ' ')" -ForegroundColor Cyan
# Merge stderr into stdout so the wrapper's exit code is driven exclusively
# by forge's process exit code, not by PowerShell's stderr handling.
& forge @fullArgs 2>&1 | ForEach-Object { "$_" }
exit $LASTEXITCODE
