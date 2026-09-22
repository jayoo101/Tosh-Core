# Move the mainnet deployer's private key out of plaintext and into an encrypted
# keystore.
#
# Why this exists: `.env.testnet-parked` holds `PRIVATE_KEY` in plaintext, and
# despite the filename that key is 0x35b232E26a275f62E594e010624aEA0c46b7874a --
# the FUNDED MAINNET DEPLOYER, holding ~0.043 BNB and carrying the nonce of the
# chain-56 deployment. The file is gitignored and has never been committed, so
# this is plaintext at rest rather than a public leak, which is why the answer is
# to move the key rather than to treat it as burned.
#
# It no longer carries authority: both contracts answer `owner()` with the Safe
# and `pendingOwner()` is zero. What it carries is the balance and the ability to
# broadcast the next deployment, which is exactly why deleting it outright would
# be the wrong repair -- and why leaving it readable is not an option either.
#
# THE PASSPHRASE NEVER REACHES THIS SCRIPT. `cast wallet import` prompts for it
# on a TTY, so this must be run in your own terminal and cannot be driven by an
# agent or a CI job. The private half is read from the dotenv into a variable,
# handed to `cast` as an argument, and never printed, logged or copied.
#
# After this, `forge script` broadcasts with `--account deployer-mainnet` instead
# of `--private-key $PRIVATE_KEY`, and asks for the passphrase each time.
#
#   .\scripts\importDeployerKey.ps1            import, verify, then empty the line
#   .\scripts\importDeployerKey.ps1 -DryRun    report what it would do, change nothing

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ACCOUNT       = 'deployer-mainnet'
$KEYSTORE_DIR  = Join-Path $env:USERPROFILE '.foundry\keystores'
$KEYSTORE      = Join-Path $KEYSTORE_DIR $ACCOUNT
$ENV_FILE      = Join-Path $PSScriptRoot '..\.env.testnet-parked'

# Pinned rather than derived from whatever the file happens to hold. A dotenv can
# be edited, and importing "whatever key is in there" under the deployer's name
# would produce a keystore that is confidently mislabelled -- the failure this
# whole exercise is about, one layer along.
$EXPECTED = '0x35b232E26a275f62E594e010624aEA0c46b7874a'

if (-not (Test-Path $ENV_FILE)) {
  Write-Host "No .env.testnet-parked at the repo root. Nothing to move."
  exit 0
}

$key = $null
foreach ($line in Get-Content $ENV_FILE) {
  if ($line -match '^\s*PRIVATE_KEY\s*=\s*(.+?)\s*$') {
    $key = $Matches[1].Trim('"').Trim("'")
  }
}

if ([string]::IsNullOrWhiteSpace($key)) {
  Write-Host "PRIVATE_KEY in .env.testnet-parked is already absent or empty. Nothing to move."
  exit 0
}

# Prove the key is the one this script is named for BEFORE writing a keystore or
# touching the file. `cast wallet address` derives locally and needs no network.
$derived = cast wallet address --private-key $key
if ($LASTEXITCODE -ne 0) {
  Write-Host "cast could not read that value as a private key. The file is not what this expects; stopping."
  exit 1
}
if ($derived.Trim().ToLower() -ne $EXPECTED.ToLower()) {
  Write-Host "The key in .env.testnet-parked controls $derived, not the deployer $EXPECTED."
  Write-Host "Refusing to import an unidentified key under the name '$ACCOUNT'. Work out what that key is first."
  exit 1
}
Write-Host "The key in .env.testnet-parked is the mainnet deployer $derived. Good."

if (Test-Path $KEYSTORE) {
  Write-Host ""
  Write-Host "A keystore named '$ACCOUNT' already exists (created $((Get-Item $KEYSTORE).CreationTime))."
  Write-Host "Refusing to overwrite it. Move it aside first if it is not the one you want."
  exit 1
}

if ($DryRun) {
  Write-Host ""
  Write-Host "DRY RUN. Would do, in this order:"
  Write-Host "  1. cast wallet import $ACCOUNT --private-key <the key>   (prompts you for a passphrase)"
  Write-Host "  2. verify $KEYSTORE names $EXPECTED"
  Write-Host "  3. empty the PRIVATE_KEY line in .env.testnet-parked, leaving a note pointing at the keystore"
  Write-Host "  4. re-run the credential inventory"
  exit 0
}

Write-Host ""
Write-Host "Importing into $KEYSTORE."
Write-Host "cast will now ask for a passphrase. CHOOSE ONE YOU CAN RECOVER -- there is no"
Write-Host "reset, and after step 3 this keystore is the only copy of the deployer's key."
Write-Host ""

cast wallet import $ACCOUNT --private-key $key
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "The import failed. .env.testnet-parked is untouched, so nothing is lost. Fix and re-run."
  exit 1
}

# Read the address back out of the keystore rather than trusting the import's own
# report. The keystore JSON carries it unencrypted, so this needs no passphrase --
# which also means this check cannot tell you the passphrase was memorable, only
# that the right key is in there. That half is on you.
if (-not (Test-Path $KEYSTORE)) {
  Write-Host "cast reported success but $KEYSTORE is not there. Stopping with the dotenv untouched."
  exit 1
}
$stored = (Get-Content $KEYSTORE -Raw | ConvertFrom-Json).address
if ($stored -notmatch '^0x') { $stored = "0x$stored" }
if ($stored.ToLower() -ne $EXPECTED.ToLower()) {
  Write-Host "$KEYSTORE names $stored, not $EXPECTED. Stopping with the dotenv untouched."
  exit 1
}
Write-Host "Keystore written and it names $EXPECTED."

# Only now is the plaintext redundant. Emptied rather than deleted, and annotated,
# because the next person to open this file should find out where the key went
# instead of concluding the deployer was never configured.
$note = @"
# EMPTIED $(Get-Date -Format 'yyyy-MM-dd') by scripts/importDeployerKey.ps1. The value that was
# here was the plaintext private key of the mainnet deployer $EXPECTED,
# which this file's name did not suggest. It now lives in the Foundry keystore
# '$ACCOUNT' (~/.foundry/keystores), encrypted under a passphrase.
#
# Broadcast with --account $ACCOUNT instead of --private-key `$PRIVATE_KEY.
# THAT KEYSTORE IS THE ONLY COPY. Losing the passphrase loses the deployer, its
# balance and the ability to broadcast a redeploy from the funded address.
PRIVATE_KEY=
"@ -replace "`r`n", "`n" -replace "`n", "`r`n"

$text = [System.IO.File]::ReadAllText($ENV_FILE)
$rewritten = [regex]::Replace($text, '(?m)^\s*PRIVATE_KEY\s*=.+\r?$', $note.TrimEnd("`r", "`n"))
if ($rewritten -eq $text) {
  Write-Host "Could not find the PRIVATE_KEY line to empty, which contradicts the read above. Left alone; edit it by hand."
  exit 1
}
# No-BOM UTF-8, and CRLF preserved: Set-Content on PowerShell 5 would add a BOM,
# and a dotenv with a BOM fails in a way that reads as a missing variable.
[System.IO.File]::WriteAllText($ENV_FILE, $rewritten, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Plaintext removed from .env.testnet-parked."

Write-Host ""
Write-Host "Confirming the inventory agrees:"
Push-Location (Join-Path $PSScriptRoot '..\soat-frontend')
try { node scripts/checkSecretStore.mjs } finally { Pop-Location }
