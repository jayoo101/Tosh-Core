# --------------------------------------------------------------------------
# scripts/precheck.ps1
#
# Pre-commit / pre-push sanity gate for Tosh-Core (Windows / PowerShell).
#
# Runs the cheap-but-effective subset of checks that catch >90% of regressions:
#   1. node scripts/checkEncoding.mjs   (source files are valid UTF-8)
#   2. forge fmt --check    (style drift)
#   3. forge build          (compile-clean)
#   4. node scripts/extractBytecode.js  (frontend bytecode stays in sync)
#   5. (optional) forge test       — pass `-WithTests` to include
#
# Usage:
#   ./scripts/precheck.ps1               # fast checks (~5s after warm cache)
#   ./scripts/precheck.ps1 -WithTests    # also run the full forge test suite
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
# --------------------------------------------------------------------------
[CmdletBinding()]
param(
    [switch]$WithTests
)

# PowerShell 5.1 treats any line a native binary writes to stderr as a
# "NativeCommandError" when $ErrorActionPreference is 'Stop', which would kill
# this script on benign warnings such as `forge build`'s "Failed to get git
# revision for dependency 'lib/forge-std'" or `forge coverage`'s warning about
# --ir-minimum. `Continue` keeps warnings visible without turning them fatal;
# we drive pass/fail strictly from $LASTEXITCODE below.
$ErrorActionPreference = 'Continue'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

function Step($label, [scriptblock]$body) {
    Write-Host ""
    Write-Host "==>" $label -ForegroundColor Cyan
    # Merge stderr into stdout so PowerShell's host error stream doesn't
    # interfere with the wrapper exit code; the child process exit code is
    # the single source of truth.
    & $body 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: $label (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

# 1. Encoding gate, first because it is the least legible failure downstream:
#    solc rejects a file that is not valid UTF-8 without naming a line, so a
#    single mangled em-dash reads as an unexplained total build failure.
Step "node scripts/checkEncoding.mjs" {
    node scripts/checkEncoding.mjs
}

# 2. fmt --check (does NOT modify files; just reports drift)
Step "forge fmt --check" {
    forge fmt --check
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  Style drift detected. Run:  forge fmt" -ForegroundColor Yellow
        Write-Host "  Then re-stage and commit." -ForegroundColor Yellow
    }
}

# 3. Compile (catches missing imports / syntax / type errors)
Step "forge build" {
    forge build
}

# 4. Keep the frontend HOOK_BYTECODE in sync with the just-built artifact.
#    Running this is idempotent — exits 0 with "already in sync" if nothing
#    changed.  If it writes a new file, the test guard would have caught it
#    in step 5, but step 5 is optional, so do it here too.
Step "node scripts/extractBytecode.js" {
    node scripts/extractBytecode.js
}

if ($WithTests) {
    Step "forge test" {
        forge test
    }
}

Write-Host ""
Write-Host "All precheck steps passed." -ForegroundColor Green
exit 0
