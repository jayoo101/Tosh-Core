$ErrorActionPreference = "Continue"
$API = "http://localhost:3000/api/sign-allocation"
$F = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$CHAIN_ID = 84532
$DKEY = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"

function Probe([string]$label, $bodyHash) {
    $body = $bodyHash | ConvertTo-Json -Compress
    try {
        $r = Invoke-WebRequest -Uri $API -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 15
        Write-Host ("  {0,-45} -> {1}  {2}" -f $label, $r.StatusCode, $r.Content)
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $msg = ""
        if ($_.ErrorDetails) { $msg = $_.ErrorDetails.Message }
        Write-Host ("  {0,-45} -> {1}  {2}" -f $label, $code, $msg)
    }
}

# helper to build a base correct payload
function BuildBase {
    $w = (cast wallet new --json) | ConvertFrom-Json
    $addr = $w[0].address; $key = $w[0].private_key
    $ts = [int64](([DateTime]::UtcNow - [DateTime]"1970-01-01").TotalMilliseconds)
    $msg = "Tosh PoG Scan Request`nAddress: $addr`nTimestamp: $ts"
    $sig = (cast wallet sign --private-key $key $msg).Trim()
    return @{ addr = $addr; key = $key; ts = $ts; msg = $msg; sig = $sig }
}

Write-Host "============================================================"
Write-Host " F1 / GATE-1 negative paths"
Write-Host "============================================================"

# N1: missing userAddress
$b = BuildBase
Probe "N1 missing userAddress" @{ contractAddress=$F; chainId=$CHAIN_ID; timestamp=$b.ts; signature=$b.sig }

# N2: malformed userAddress
Probe "N2 malformed userAddress" @{ userAddress="not-an-addr"; contractAddress=$F; chainId=$CHAIN_ID; timestamp=$b.ts; signature=$b.sig }

# N3: unsupported chainId
Probe "N3 chainId=99999 (unsupported)" @{ userAddress=$b.addr; contractAddress=$F; chainId=99999; timestamp=$b.ts; signature=$b.sig }

# N4: timestamp too old (40 min ago, > 30 min window)
$old = $b.ts - (40 * 60 * 1000)
$oldMsg = "Tosh PoG Scan Request`nAddress: $($b.addr)`nTimestamp: $old"
$oldSig = (cast wallet sign --private-key $b.key $oldMsg).Trim()
Probe "N4 timestamp 40 min ago (> 30 min window)" @{ userAddress=$b.addr; contractAddress=$F; chainId=$CHAIN_ID; timestamp=$old; signature=$oldSig }

# N5: signature signed by wrong wallet
$w2 = (cast wallet new --json) | ConvertFrom-Json
$wrongSig = (cast wallet sign --private-key $w2[0].private_key $b.msg).Trim()
Probe "N5 wallet auth sig from wrong wallet" @{ userAddress=$b.addr; contractAddress=$F; chainId=$CHAIN_ID; timestamp=$b.ts; signature=$wrongSig }

# N6: SaaS-style clean text body (no Tosh domain prefix)
$cleanMsg = "Address: $($b.addr)`nTimestamp: $($b.ts)"
$cleanSig = (cast wallet sign --private-key $b.key $cleanMsg).Trim()
Probe "N6 clean-text body (no domain prefix)" @{ userAddress=$b.addr; contractAddress=$F; chainId=$CHAIN_ID; timestamp=$b.ts; signature=$cleanSig }

# N7: tampered timestamp (signed at ts, but body says ts + 1000)
Probe "N7 body ts != signed ts" @{ userAddress=$b.addr; contractAddress=$F; chainId=$CHAIN_ID; timestamp=($b.ts + 1000); signature=$b.sig }

# N8: malformed contractAddress
Probe "N8 malformed contractAddress" @{ userAddress=$b.addr; contractAddress="0xnotahex"; chainId=$CHAIN_ID; timestamp=$b.ts; signature=$b.sig }

# N9: malformed body (not JSON)
try {
    $r = Invoke-WebRequest -Uri $API -Method Post -ContentType "application/json" -Body "not-json" -UseBasicParsing -TimeoutSec 5
    Write-Host ("  {0,-45} -> {1}  {2}" -f "N9 invalid JSON body", $r.StatusCode, $r.Content)
} catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $msg = ""
    if ($_.ErrorDetails) { $msg = $_.ErrorDetails.Message }
    Write-Host ("  {0,-45} -> {1}  {2}" -f "N9 invalid JSON body", $code, $msg)
}

# Positive control: re-issue a successful request to confirm gate works overall
Write-Host ""
Write-Host "POSITIVE CONTROL (must succeed):"
$b2 = BuildBase
Probe "P  fresh wallet, valid sig" @{ userAddress=$b2.addr; contractAddress=$F; chainId=$CHAIN_ID; timestamp=$b2.ts; signature=$b2.sig }

Write-Host ""
Write-Host "============================================================"
Write-Host " GATE-1 NEGATIVE BATCH DONE"
Write-Host "============================================================"
