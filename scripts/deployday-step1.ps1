# Deploy-day step 1, as one command instead of a multi-line paste.
#
# Does exactly what docs/MAINNET_REDEPLOY.md §3 says to do — park .env, export
# .env.production, take the key by hand, prove the key and prove the export —
# and nothing else. It does not broadcast and it writes no secret to disk.
#
# Run it as `.\scripts\deployday-step1.ps1` from the repo root. Env vars set here
# persist into your session (verified), so the dry run and broadcast that follow
# will see them. It must be the SAME window for the rest of the deploy.
#
# Disposable: delete it in §7 cleanup along with the parked .env.

$ErrorActionPreference = 'Stop'

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($t)       { Write-Host "    ok   $t" -ForegroundColor Green }
function Die($t)      { Write-Host "`nSTOP: $t`n" -ForegroundColor Red; exit 1 }

# ── 0. Right directory, right files ──────────────────────────────────────────
Step 0 'Checking the working directory'
if (-not (Test-Path 'foundry.toml') -or -not (Test-Path 'script\DeployMainnet.s.sol')) {
  Die 'Run this from the repo root (the folder holding foundry.toml).'
}
if (-not (Test-Path '.env.production')) { Die '.env.production is missing.' }
Ok "repo root: $(Get-Location)"

# ── 1. Park .env ─────────────────────────────────────────────────────────────
# Not belt-and-braces. Exporting the right values is enough ONLY if the export is
# complete; a parked .env is what makes an incomplete export fail loudly instead
# of silently supplying chain-97 values.
Step 1 'Parking .env so a missed export cannot fall through to chain 97'
if (Test-Path '.env') {
  if (Test-Path '.env.testnet-parked') {
    Die '.env and .env.testnet-parked both exist. Sort that out by hand — one of them is not what you think.'
  }
  Rename-Item '.env' '.env.testnet-parked'
  Ok 'renamed .env -> .env.testnet-parked'
} elseif (Test-Path '.env.testnet-parked') {
  Ok 'already parked (.env.testnet-parked present)'
} else {
  Die 'Neither .env nor .env.testnet-parked exists. Expected the deployer key to be in one of them.'
}

# ── 2. Export .env.production ────────────────────────────────────────────────
Step 2 'Exporting .env.production into this session'
$n = 0
foreach ($raw in (Get-Content '.env.production')) {
  if ($raw -notmatch '^[A-Z_][A-Z0-9_]*=') { continue }
  $k, $v = ($raw -split '=', 2)
  Set-Item -Path "Env:\$k" -Value $v.Trim()
  $n++
}
if ($n -eq 0) { Die 'Read 0 variables out of .env.production. Do not continue — the file did not parse.' }
Ok "$n variables exported"

# ── 3. The key, by hand ──────────────────────────────────────────────────────
# .env.production carries DEPLOYER_ADDRESS but deliberately not the key.
Step 3 'Deployer private key'
Write-Host '    The key is the PRIVATE_KEY line inside .env.testnet-parked.'
Write-Host '    Paste it at the prompt. NOTHING WILL APPEAR AS YOU PASTE -- that is'
Write-Host '    the prompt hiding it, not a hang. Press Enter when pasted.'
$sec = Read-Host -Prompt '    mainnet deployer PRIVATE_KEY' -AsSecureString
$env:PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if (-not $env:PRIVATE_KEY) { Die 'No key entered.' }
if ($env:PRIVATE_KEY -notmatch '^0x[0-9a-fA-F]{64}$') {
  $env:PRIVATE_KEY = $null
  Die 'That is not a 0x-prefixed 32-byte key. Cleared it. Check for a stray space or a missing 0x.'
}
Ok 'key read (not stored, not echoed)'

# ── 4. Prove the key is the wallet you funded ────────────────────────────────
Step 4 'Proving the key matches DEPLOYER_ADDRESS'
$derived = (cast wallet address --private-key $env:PRIVATE_KEY).Trim()
$declared = $env:DEPLOYER_ADDRESS
Write-Host "    derived from key : $derived"
Write-Host "    .env.production  : $declared"
if ($derived.ToLower() -ne $declared.ToLower()) {
  $env:PRIVATE_KEY = $null
  Die 'The key signs for a DIFFERENT address than the one every check funded. Cleared the key.'
}
Ok 'same wallet'

# ── 5. Prove the export landed ───────────────────────────────────────────────
# A silently empty export is the failure that does not announce itself.
# PLATFORM_TREASURY is the one to fear: fall through to .env's chain-97
# throwaway and it becomes the immutable recipient of 0.30 % of every buy,
# baked into the hook implementation. Remedy is redeploying everything.
Step 5 'Proving every variable the broadcast depends on is set'
$must = 'TARGET_CHAIN_ID', 'TARGET_RPC', 'PLATFORM_TREASURY', 'PROD_OWNER_SAFE',
        'POG_SIGNER_ADDRESS', 'QUOTE_ASSET', 'INFINITY_CL_POOL_MANAGER', 'INFINITY_VAULT'
$bad = $must | Where-Object { -not $(Get-Item "Env:\$_" -ErrorAction SilentlyContinue).Value }
if ($bad) { Die "NOT EXPORTED: $($bad -join ', ') -- do not broadcast." }
Write-Host ''
$must | ForEach-Object { Write-Host ('    {0,-26} {1}' -f $_, (Get-Item "Env:\$_").Value) }

# ── 6. The two that must be read, not just be present ────────────────────────
Step 6 'Checking the two values that fail permanently and silently'
if ($env:TARGET_CHAIN_ID -ne '56') { Die "TARGET_CHAIN_ID is '$($env:TARGET_CHAIN_ID)', not 56." }
Ok 'TARGET_CHAIN_ID is 56'
if ($env:PLATFORM_TREASURY.ToLower() -ne $env:PROD_OWNER_SAFE.ToLower()) {
  Die "PLATFORM_TREASURY ($env:PLATFORM_TREASURY) is not the owner Safe ($env:PROD_OWNER_SAFE). PM-C9 decided they are the same Safe."
}
Ok 'PLATFORM_TREASURY is the owner Safe (PM-C9)'

Write-Host "`nStep 1 done. This window is now the deploy session -- do not close it.`n" -ForegroundColor Green
Write-Host 'Next, the DRY RUN (sends nothing):'
Write-Host '  forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv' -ForegroundColor Yellow
Write-Host ''
