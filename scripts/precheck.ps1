# --------------------------------------------------------------------------
# scripts/precheck.ps1
#
# Pre-commit / pre-push sanity gate for Tosh-Core (Windows / PowerShell).
#
# Runs the cheap-but-effective subset of checks that catch >90% of regressions:
#   1. node scripts/checkEncoding.mjs   (every TRACKED source file is valid
#      UTF-8, NUL-free, LF-only and free of GBK round-trip damage — note that
#      the three most common causes are PowerShell, which is what you are
#      running this in; the guard's header names them)
#   2. forge fmt --check    (style drift)
#   3. forge build          (compile-clean)
#   4. cross-language tuple guards (PoG digest, pool geometry, salt miner,
#      Infinity posm ABI, Infinity router tuple, lint findings, doc symbols)
#   5. node scripts/checkPublicEnv.mjs  (NEXT_PUBLIC_* really reaches the browser)
#   6. node scripts/checkServerRpc.mjs  (no RPC endpoint chosen without a chain id)
#   7. node scripts/checkSupabase.mjs   (every Supabase query carries a deadline)
#   8. (optional) forge test       — pass `-WithTests` to include
#
# Everything here also runs in CI (.github/workflows/test.yml). This script is
# the fast local copy, not the authority — do not add a check here instead of
# there. A guard only this script runs is a guard that only runs on Windows,
# only for whoever remembers, which is how the salt-miner guard managed to be
# red and unnoticed long enough to ship.
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

# 4. Cross-language tuple guards. These are the checks that catch a change
#    which compiles on both sides and passes every test while being wrong on
#    chain — the class that has actually shipped from this repository before.
#    They cost milliseconds, so there is no reason to make them opt-in.
Step "node scripts/checkPogDigestTuple.mjs" {
    node scripts/checkPogDigestTuple.mjs
}

Step "node scripts/checkPoolGeometry.mjs" {
    node scripts/checkPoolGeometry.mjs
}

Step "node scripts/checkCloneInitcodeTuple.mjs" {
    node scripts/checkCloneInitcodeTuple.mjs
}

# The LP panel hand-encodes Infinity posm payloads. This half pins the offsets
# and opcodes against lib/infinity-periphery; the TypeScript encoder half lives
# in soat-frontend and is run by frontend.yml. Both must stay wired — a
# five-member V4 key still encodes and still hashes to a pool nobody opened.
Step "node scripts/checkLpActionsAbi.mjs" {
    node scripts/checkLpActionsAbi.mjs
}

# Pins the hand-rolled UniversalRouter tuple against the deployed Infinity
# decoder. A V4-shaped tuple is well-formed and wrong; this is the check that
# names the collision rather than letting a swap revert in a wallet popup.
Step "node scripts/checkV4RouterTuple.mjs" {
    node scripts/checkV4RouterTuple.mjs
}

# The narrowing-cast triage is a SET, not a count. forge lint here, not in CI
# only — two red builds this port shipped were guards this script did not run.
Step "node scripts/checkLintFindings.mjs" {
    node scripts/checkLintFindings.mjs
}

# A dangling Solidity symbol in a security-facing doc is a control nobody can
# check. Cheap, local, and already in test.yml.
Step "node scripts/checkDocSymbols.mjs" {
    node scripts/checkDocSymbols.mjs
}

# Catches `process.env[name]`, which Next.js cannot inline, and env vars the
# production template documents but no source file statically reads.
Step "node scripts/checkPublicEnv.mjs (soat-frontend)" {
    Push-Location soat-frontend
    try { node scripts/checkPublicEnv.mjs } finally { Pop-Location }
}

# Catches an RPC endpoint picked without an explicit chain id — a chain-named
# env var honoured on a chain it does not name, or a hardcoded URL that some
# other target chain inherits as its default.
Step "node scripts/checkServerRpc.mjs (soat-frontend)" {
    Push-Location soat-frontend
    try { node scripts/checkServerRpc.mjs } finally { Pop-Location }
}

# Catches a Supabase query with no deadline. supabase-js has no default timeout
# and retries 4x with backoff, so an unreachable registry grinds for ~14s rather
# than failing.
Step "node scripts/checkSupabase.mjs (soat-frontend)" {
    Push-Location soat-frontend
    try { node scripts/checkSupabase.mjs } finally { Pop-Location }
}

if ($WithTests) {
    Step "forge test" {
        forge test
    }
}

Write-Host ""
Write-Host "All precheck steps passed." -ForegroundColor Green
exit 0
