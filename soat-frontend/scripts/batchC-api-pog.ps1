$ErrorActionPreference = "Continue"

# ─── F1 / F2 — Live /api/sign-allocation end-to-end ──────────────────────────
# Pipeline:
#  1) Generate ephemeral wallet via `cast wallet new`
#  2) Sign EIP-191 GATE-1 message "Tosh PoG Scan Request\nAddress: {addr}\nTimestamp: {ms}"
#  3) POST to local /api/sign-allocation
#  4) Validate response: maxAlloc, signature recovery to pogSigner, EIP-191 digest reconstruction
#  5) Compare API maxAlloc to manual computation from pogQuota.ts constants

$API = "http://localhost:3000/api/sign-allocation"
$DKEY = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"  # pogSigner (= deployer)
$F = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$CHAIN_ID = 84532

Write-Host "============================================================"
Write-Host " F1+F2 / Live PoG attestation gateway probe"
Write-Host "============================================================"
Write-Host ""
Write-Host "Endpoint        : $API"
Write-Host "ToshFactory     : $F"
Write-Host "Chain id        : $CHAIN_ID"

# ─── Step 1 · Generate a brand-new wallet ────────────────────────────────────
$w = (cast wallet new --json) | ConvertFrom-Json
$USER = $w[0].address
$USER_KEY = $w[0].private_key
Write-Host ""
Write-Host "Test wallet     : $USER"

# ─── Step 2 · Sign EIP-191 GATE-1 auth message ────────────────────────────────
$ts = [int64][Math]::Floor((Get-Date -UFormat %s)) * 1000  # epoch ms
$ts = [int64](([DateTime]::UtcNow - [DateTime]"1970-01-01").TotalMilliseconds)
$msg = "Tosh PoG Scan Request`nAddress: $USER`nTimestamp: $ts"
Write-Host ""
Write-Host "GATE-1 message  : (raw)"
Write-Host ($msg -split "`n" | ForEach-Object { "                  $_" })

# cast wallet sign with --no-hash signs over the raw text (applies EIP-191 framing internally)
$walletAuthSig = (cast wallet sign --private-key $USER_KEY $msg).Trim()
Write-Host ""
Write-Host "wallet auth sig : $walletAuthSig"

# ─── Step 3 · POST to /api/sign-allocation ───────────────────────────────────
$bodyObj = @{
    userAddress     = $USER
    contractAddress = $F
    chainId         = $CHAIN_ID
    timestamp       = $ts
    signature       = $walletAuthSig
}
$body = $bodyObj | ConvertTo-Json -Compress
Write-Host ""
Write-Host "POST body       : $body"

$resp = $null
try {
    $resp = Invoke-RestMethod -Uri $API -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
} catch {
    Write-Host ""
    Write-Host "API call failed: $($_.Exception.Message)"
    if ($_.ErrorDetails) { Write-Host "Detail: $($_.ErrorDetails.Message)" }
    exit 1
}

Write-Host ""
Write-Host "API response:"
$resp | ConvertTo-Json | Write-Host

# ─── Step 4 · Manual maxAlloc computation ────────────────────────────────────
# pogQuota.ts: MOCK_CHAIN_GAS sums to 0.033 ETH × 200 = 6.6 → Math.floor = 6 → 6e18 wei
$gasEth = 0.015 + 0.008 + 0.006 + 0.004
$gasRate = 200
$expectedSato = [Math]::Floor($gasEth * $gasRate)
$expectedWei = [System.Numerics.BigInteger]::Parse($expectedSato.ToString()) * [System.Numerics.BigInteger]::Pow(10, 18)
Write-Host ""
Write-Host "Manual maxAlloc check:"
Write-Host "  totalGasEth        : $gasEth"
Write-Host "  gasToSatoRate      : $gasRate"
Write-Host "  floor(0.033 * 200) : $expectedSato SATO"
Write-Host "  expected (wei)     : $expectedWei"
Write-Host "  API returned       : $($resp.maxAlloc)"
$apiMaxAlloc = [System.Numerics.BigInteger]::Parse($resp.maxAlloc)
if ($apiMaxAlloc -eq $expectedWei) {
    Write-Host "  -> bit-exact match ✓"
} else {
    Write-Host "  -> MISMATCH ✗"
}

# ─── Step 5 · Verify the API gasEth/gasToSatoRate echoes ─────────────────────
Write-Host ""
Write-Host "API meta echo check:"
Write-Host "  API gasEth         : $($resp.gasEth)"
Write-Host "  API gasToSatoRate  : $($resp.gasToSatoRate)"
Write-Host "  API authDomain     : $($resp.authDomain)"

# ─── Step 6 · Reconstruct EIP-191 digest from API fields and verify signature recovers to pogSigner ──
# Use cast abi-encode + cast keccak to rebuild the exact digest the contract will check
$encoded = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $USER $resp.maxAlloc $resp.nonce $resp.deadline $F $CHAIN_ID).Trim()
$inner = (cast keccak $encoded).Trim()
Write-Host ""
Write-Host "Manual digest reconstruction:"
Write-Host "  ABI encoded        : $encoded"
Write-Host "  keccak (innerHash) : $inner"
Write-Host "  API signature      : $($resp.signature)"

# Now compute the EIP-191-framed hash: keccak256("\x19Ethereum Signed Message:\n32" || inner)
# Then ecrecover(framedHash, sig) should equal $resp.issuer (= pogSigner from .env.local)
$recovered = (cast wallet verify --address $resp.issuer $inner $resp.signature 2>&1)
Write-Host ""
Write-Host "Signature verify (against API issuer $($resp.issuer)):"
Write-Host "  $recovered"

# Also confirm via direct on-chain ecrecover semantics: build EIP-191-framed prefix
$prefix = "0x19457468657265756d205369676e6564204d6573736167653a0a3332"  # "\x19Ethereum Signed Message:\n32"
$framedPayload = $prefix + $inner.Substring(2)
$framedHash = (cast keccak $framedPayload).Trim()
Write-Host ""
Write-Host "EIP-191 framed hash : $framedHash"
$ecrec = (cast wallet recover-message $inner --signature $resp.signature 2>&1)
Write-Host "  recover (cast)    : $ecrec"

Write-Host ""
Write-Host "============================================================"
Write-Host " F1+F2 COMPLETE"
Write-Host "============================================================"
