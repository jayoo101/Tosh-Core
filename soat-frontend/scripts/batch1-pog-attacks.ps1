$ErrorActionPreference = "Continue"  # don't bail on revert
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$FAKE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" # random foreign key
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

function Report($label, $out) {
    $hit = $out -match "execution reverted.*data:\s*\""(0x[0-9a-f]+)\""|status\s+1"
    if ($out -match "data: ""(0x[0-9a-fA-F]{8,})""") {
        $selector = $matches[1].Substring(0,10)
        $dec = (cast 4byte $selector 2>&1) -join " "
        Write-Host ("  {0,-44} → reverted {1}  {2}" -f $label, $selector, $dec)
    } elseif ($out -match "status\s+1") {
        Write-Host ("  {0,-44} → STATUS 1 (no revert)" -f $label)
    } else {
        Write-Host ("  {0,-44} → {1}" -f $label, ($out | Select-Object -First 1))
    }
}

# Build a wallet (W_A) that has nonce 0 and no quota
$w = (cast wallet new --json) | ConvertFrom-Json
$A     = $w[0].address
$A_KEY = $w[0].private_key
Write-Host "victim wallet A = $A"
[void](cast rpc anvil_setBalance $A 0xde0b6b3a7640000 --rpc-url $ANVIL)

Write-Host "------------------------------------------------------------"
Write-Host "M1 / PoG NONCE REPLAY"
Write-Host "------------------------------------------------------------"
# First valid registerPoG to push nonce 0 → 1
$nonce = 0
$now      = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$deadline = ([int64]$now + 3600).ToString()
$maxAlloc = "1000000000000000000" # 1 SATO
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $maxAlloc $nonce $deadline $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
$ok = cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $deadline $nonce $sig --rpc-url $ANVIL --private-key $A_KEY 2>&1
Report "first registerPoG (nonce=0)" $ok
$replay = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $deadline $nonce $sig --rpc-url $ANVIL 2>&1
Report "replay same nonce=0" $replay

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M2 / PoG FORGED SIGNATURE (wrong signer)"
Write-Host "------------------------------------------------------------"
$nonce = ((cast call $F "pogNonces(address)(uint256)" $A --rpc-url $ANVIL).Trim() -split " ")[0]
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $maxAlloc $nonce $deadline $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$fake = (cast wallet sign --private-key $FAKE_KEY $inner).Trim()  # signed by random key
$out = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $deadline $nonce $fake --rpc-url $ANVIL 2>&1
Report "forged sig from random key" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M3 / PoG EXPIRED (deadline = now-1)"
Write-Host "------------------------------------------------------------"
$nonce = ((cast call $F "pogNonces(address)(uint256)" $A --rpc-url $ANVIL).Trim() -split " ")[0]
$past  = ([int64]$now - 1).ToString()
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $maxAlloc $nonce $past $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
$out = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $past $nonce $sig --rpc-url $ANVIL 2>&1
Report "deadline in past" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M4 / PoG TOO LONG (deadline = now + 25h, max validity 24h)"
Write-Host "------------------------------------------------------------"
$farFuture = ([int64]$now + 90000).ToString()  # 25 hours
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $maxAlloc $nonce $farFuture $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
$out = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $farFuture $nonce $sig --rpc-url $ANVIL 2>&1
Report "deadline > now+24h" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M5 / PoG OVER-CAP (maxAlloc > maxPogAllocationLimit)"
Write-Host "------------------------------------------------------------"
$over = "200000000000000000000000"  # 200,000 SATO (cap is 100,000 SATO)
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $over $nonce $deadline $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
$out = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $over $deadline $nonce $sig --rpc-url $ANVIL 2>&1
Report "maxAlloc=200k > global 100k" $out

# Persist A for later use
@{ a_addr = $A; a_key = $A_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-wA.json"
