# Rotate the PoG signing key.
#
# Why this exists: the mainnet signer's private half is not recoverable, so the
# factory is pointing at an address nobody can sign for and every genesis
# deposit fails closed. `setPogSigner` is onlyOwner, so the Safe can repoint it
# -- but only at a key somebody actually holds, and NOT at whatever Vercel was
# carrying, which the runbook records as a leaked testnet key. Whoever holds the
# PoG key can sign arbitrary `maxAlloc` values, which is unlimited deposit
# quota. So: a fresh pair, and nothing reused.
#
# Two modes:
#   .\scripts\rotatePogSigner.ps1                 generate a new pair
#   .\scripts\rotatePogSigner.ps1 -UseExisting    reuse the keystore already
#                                                 written, and finish the rest
#
# -UseExisting exists because a partial run is the normal failure here, not an
# exotic one: generating the key, writing three Vercel environments and getting
# a Safe signature are separate operations and the middle one can fail on its
# own. Without a resume path the only way forward is a second key, which means
# guessing which of two keys production is actually holding.
#
# The private half never reaches stdout, the command line, the clipboard, or
# disk in plaintext. It exists as a string in this process and is piped straight
# into `vercel env add`'s stdin. `cast wallet new` prints only the address, and
# `decrypt-keystore` prints the key with a label, so it is matched out rather
# than piped raw.

param(
  [switch]$UseExisting,
  # Narrow the run to specific environments. Worth having because a write can
  # fail to land on one environment while the others are correct, and redoing
  # the correct ones just exposes them to the same flake.
  [ValidateSet('production','preview','development')]
  [string[]]$Targets = @('production','preview','development')
)

$ErrorActionPreference = 'Stop'

# The Vercel CLI prints its version banner to stderr even when the command
# succeeds, and under `Stop` a redirected stderr record from a native command is
# a terminating error -- so the script died on a banner, before writing
# anything. Native calls go through here, where the preference is relaxed
# (function scope, so cmdlet errors outside still stop the script) and success
# is judged only by exit code.
function Invoke-Vercel {
  param([string[]]$Arguments, [string]$StdIn)
  $ErrorActionPreference = 'Continue'
  if ($PSBoundParameters.ContainsKey('StdIn')) {
    $StdIn | vercel @Arguments 2>&1 | Out-Null
  } else {
    vercel @Arguments 2>&1 | Out-Null
  }
  return $LASTEXITCODE
}

function Get-VercelEnvLines {
  param([string]$Name)
  $ErrorActionPreference = 'Continue'
  return (vercel env ls 2>&1 | Select-String $Name)
}

$KEYSTORE_DIR  = Join-Path $env:USERPROFILE '.foundry\keystores'
$ACCOUNT       = 'pog-mainnet'
$FACTORY       = '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'
$FRONTEND_DIR  = Join-Path $PSScriptRoot '..\soat-frontend'
$KEYSTORE      = Join-Path $KEYSTORE_DIR $ACCOUNT

$exists = Test-Path $KEYSTORE
if ($exists -and -not $UseExisting) {
  Write-Host "A keystore named '$ACCOUNT' already exists (created $((Get-Item $KEYSTORE).CreationTime))."
  Write-Host ''
  Write-Host 'If an earlier run made it, do NOT generate a second key -- rerun with:'
  Write-Host '    .\scripts\rotatePogSigner.ps1 -UseExisting'
  Write-Host 'which reuses it and redoes every Vercel environment, so all three'
  Write-Host 'provably hold the same key.'
  exit 2
}
if (-not $exists -and $UseExisting) {
  Write-Host "No keystore named '$ACCOUNT' to reuse. Run without -UseExisting."
  exit 2
}

# ── password ─────────────────────────────────────────────────────────────────
if ($UseExisting) {
  Write-Host "=== Unlocking the existing '$ACCOUNT' keystore ==="
  $p1 = Read-Host 'Password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
  $pw   = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} else {
  Write-Host '=== 1. Choose a password for the new keystore ==='
  Write-Host 'Losing it loses the key again, so put it in your password manager now.'
  $p1 = Read-Host 'Password' -AsSecureString
  $p2 = Read-Host 'Confirm ' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
  $pw   = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  $bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
  $pw2  = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr2)
  if ($pw -ne $pw2) { Write-Host 'They do not match. Nothing was created.'; exit 2 }
  if ($pw.Length -lt 12) { Write-Host 'Use at least 12 characters. Nothing was created.'; exit 2 }

  New-Item -ItemType Directory -Path $KEYSTORE_DIR -Force | Out-Null
  Write-Host "`n=== 2. Generating the keypair ==="
  $env:CAST_PASSWORD = $pw
  $new = cast wallet new $KEYSTORE_DIR $ACCOUNT 2>&1
  Remove-Item Env:\CAST_PASSWORD
  if ($LASTEXITCODE -ne 0) { Write-Host 'Generation failed:'; $new; exit 1 }
}

# ── pull the private half into memory only ───────────────────────────────────
$env:CAST_UNSAFE_PASSWORD = $pw
$dec = cast wallet decrypt-keystore $ACCOUNT -k $KEYSTORE_DIR 2>&1
Remove-Item Env:\CAST_UNSAFE_PASSWORD
$pw = $null; $pw2 = $null
$key = ([regex]::Match(($dec -join "`n"), '0x[a-fA-F0-9]{64}')).Value
$dec = $null
if (-not $key) {
  Write-Host 'Could not unlock the keystore -- wrong password, most likely.'
  Write-Host 'Nothing was changed.'
  exit 1
}

# Derived rather than read from the keystore file: `cast wallet new` writes no
# address field, so the file alone cannot tell you which key it holds.
$addr = (cast wallet address --private-key $key 2>&1 | Select-Object -First 1).Trim()
Write-Host "`n  signer address: $addr"
Write-Host "  keystore:       $KEYSTORE"

# ── into Vercel, via stdin ───────────────────────────────────────────────────
Write-Host "`n=== Writing POG_SIGNER_PRIVATE_KEY to Vercel ==="
# All three targets every time, even on a resume, so that afterwards all three
# provably hold this key. A partial run otherwise leaves production on one key
# and preview on another, and Vercel will not read a secret back to let you tell
# which is which.
#
# The delete-then-add fallback is here because `--force` does not reliably
# overwrite an entry that spans several targets at once (the dashboard can
# create one row covering Preview and Development together), which is how the
# earlier run wrote production and silently left the other two alone.
$failed = @()
Push-Location $FRONTEND_DIR
try {
  foreach ($target in $Targets) {
    # Deleted first, unconditionally, rather than relying on `--force`: forcing
    # an existing entry exits 0 whether or not it replaced anything (measured --
    # re-forcing a name left its age counting from the original write), and the
    # value cannot be read back to check, because Vercel returns the string
    # "[SENSITIVE]" in place of a secret. A delete followed by an add is the
    # only sequence whose effect is observable: the entry is new, so its age
    # resets.
    #
    # The gap where the variable is absent is safe here only because the value
    # currently deployed is already the wrong one. Do not lift this into a
    # script that touches a working secret.
    #
    # Verified per environment rather than once at the end, and retried,
    # because an add has been seen to exit 0 having created nothing: that run
    # printed "written" for all three and left preview with no entry at all,
    # which is worse than the wrong value it replaced. Exit codes do not settle
    # this; the listing does.
    $label = (Get-Culture).TextInfo.ToTitleCase($target)

    # Each step waits for the listing to agree before the next one is issued.
    # Firing rm and add back to back loses the entry outright: both exit 0, but
    # the listing lags the write, and a delete that takes effect after the add
    # deletes the entry the add just created. That is how preview ended up with
    # no variable at all while the script reported success.
    Invoke-Vercel -Arguments @('env','rm','POG_SIGNER_PRIVATE_KEY',$target,'--yes') | Out-Null
    for ($poll = 1; $poll -le 10; $poll++) {
      Start-Sleep -Seconds 3
      if (-not (Get-VercelEnvLines -Name 'POG_SIGNER_PRIVATE_KEY' | Where-Object { $_ -match "\b$label\b" })) { break }
    }

    $rc = Invoke-Vercel -Arguments @('env','add','POG_SIGNER_PRIVATE_KEY',$target,'--sensitive','--force') -StdIn $key
    $ok = $false
    for ($poll = 1; $poll -le 10 -and -not $ok; $poll++) {
      Start-Sleep -Seconds 3
      $row = Get-VercelEnvLines -Name 'POG_SIGNER_PRIVATE_KEY' | Where-Object { $_ -match "\b$label\b" }
      # Age must read in seconds: the entry was removed above, so a fresh one is
      # the only thing that can be here. An age in minutes means the delete
      # never took and `--force` overrode in place, which leaves the age
      # counting from the original write and tells you nothing about the value.
      $ok = ($rc -eq 0) -and $row -and ("$row" -match '\d+s ago')
    }
    if ($ok) { Write-Host "  $target : written, entry is new" }
    else { Write-Host "  $target : FAILED"; $failed += $target }
  }

  Write-Host "`n  Final state -- all three environments must be present:"
  $lines = Get-VercelEnvLines -Name 'POG_SIGNER_PRIVATE_KEY'
  $lines | ForEach-Object { Write-Host ("    " + $_.ToString().Trim()) }
  foreach ($env3 in @('Production','Preview','Development')) {
    if (-not ($lines | Where-Object { $_ -match "\b$env3\b" })) {
      Write-Host "    $env3 : MISSING"
      $failed += "$env3 missing"
    }
  }
}
finally {
  # In a finally block so a failure here cannot strand the caller's shell in
  # soat-frontend, which is what the previous version did when it crashed.
  Pop-Location
  $key = $null
  [GC]::Collect()
}

if ($failed.Count) {
  Write-Host "`nStopping: $($failed -join ', ') did not take. Do NOT run the Safe"
  Write-Host 'transaction yet, or you will point the chain at a signer the site'
  Write-Host 'cannot use on those environments.'
  exit 1
}

# ── what is left, which is not automatable ───────────────────────────────────
$calldata = cast calldata 'setPogSigner(address)' $addr 2>&1

Write-Host "`n=== Three things left, in this order ==="
Write-Host ''
Write-Host '  a) Safe transaction -- this is what actually fixes the chain:'
Write-Host "       to:       $FACTORY"
Write-Host '       value:    0'
Write-Host "       calldata: $calldata"
Write-Host '     Needs 2 of 3 signatures. WATCHER will page on the signer change;'
Write-Host '     that alert is correct and expected, so do (b) close to it.'
Write-Host ''
Write-Host '  b) Update the two places that record the expected address:'
Write-Host "       gh variable set MONITOR_EXPECTED_POG_SIGNER --body $addr"
Write-Host "       .env.production  ->  POG_SIGNER_ADDRESS=$addr"
Write-Host ''
Write-Host '  c) Redeploy Vercel, then click ACTIVATE DEPOSIT QUOTA once.'
Write-Host '     The env change does nothing until a redeploy picks it up, and'
Write-Host '     only the button proves the whole path end to end.'
