$ErrorActionPreference = "Stop"
$ANVIL    = "http://127.0.0.1:8545"
$DKEY     = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$DEPLOYER = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$FACTORY  = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO     = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"
$HOOK     = "0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7"
$NEW_TREASURY = "0x52660B62fa29d7e0a3aBc345eB330D18F8768a7e"

Write-Host "============================================================"
Write-Host " STAGE 1 / GENERATE W2 + FUND"
Write-Host "============================================================"
$w2 = (cast wallet new --json) | ConvertFrom-Json
$W2_ADDR = $w2[0].address
$W2_KEY  = $w2[0].private_key
Write-Host "W2 ADDR : $W2_ADDR"
Write-Host "W2 KEY  : (hidden)"

# Fund W2: 1 ETH
[void](cast rpc anvil_setBalance $W2_ADDR 0xde0b6b3a7640000 --rpc-url $ANVIL)
# Fund W2: 8000 SATO from deployer
[void](cast send $SATO "transfer(address,uint256)" $W2_ADDR 8000000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

$ethBal  = (cast balance $W2_ADDR --rpc-url $ANVIL).Trim()
$satoBal = (cast call $SATO "balanceOf(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim()
Write-Host "W2 ETH  : $ethBal"
Write-Host "W2 SATO : $satoBal"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 2 / W2 REGISTERS POG QUOTA 7994 SATO"
Write-Host "============================================================"
$nonce = ((cast call $FACTORY "pogNonces(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$now      = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$deadline = ([int64]$now + 3600).ToString()
$maxAlloc = "7994000000000000000000"
Write-Host "nonce    : $nonce"
Write-Host "deadline : $deadline (= now+1h)"
Write-Host "maxAlloc : 7994 SATO"

$encoded = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $W2_ADDR $maxAlloc $nonce $deadline $FACTORY 84532).Trim()
$inner   = (cast keccak $encoded).Trim()
$sig     = (cast wallet sign --private-key $DKEY $inner).Trim()
Write-Host "inner    : $inner"
Write-Host "sig len  : $($sig.Length) chars"

$out = cast send $FACTORY "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $deadline $nonce $sig --rpc-url $ANVIL --private-key $W2_KEY 2>&1
$st  = ($out | Select-String "^status").Line
Write-Host "registerPoG : $st"
$q = ((cast call $FACTORY "pogQuota(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "W2 pogQuota: $q"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 3 / W2 APPROVE + DEPOSIT 7994 SATO INTO AAA HOOK"
Write-Host "============================================================"
$out = cast send $SATO "approve(address,uint256)" $FACTORY 7994000000000000000000 --rpc-url $ANVIL --private-key $W2_KEY 2>&1
$st  = ($out | Select-String "^status").Line
Write-Host "approve     : $st"

$out = cast send $FACTORY "deposit(address,uint256)" $HOOK 7994000000000000000000 --rpc-url $ANVIL --private-key $W2_KEY 2>&1
$st  = ($out | Select-String "^status").Line
Write-Host "deposit     : $st"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 4 / VERIFY softCap MET"
Write-Host "============================================================"
$total = ((cast call $HOOK "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$cap   = ((cast call $HOOK "softCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "totalSatoDeposited : $total"
Write-Host "softCap            : $cap"
$wD = ((cast call $HOOK "satoDeposited(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$dD = ((cast call $HOOK "satoDeposited(address)(uint256)" $DEPLOYER --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "W2 deposit       : $wD"
Write-Host "deployer deposit : $dD"

# Persist W2 info to a tmp file so the launch script can read it
@{ w2_addr = $W2_ADDR; w2_key = $W2_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-w2.json"
Write-Host ""
Write-Host "Saved W2 keypair to .fork-w2.json for next stage"
