$ErrorActionPreference = "Stop"
$ANVIL    = "http://127.0.0.1:8545"
$DKEY     = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$DEPLOYER = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$FACTORY  = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$HOOK     = "0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7"

Write-Host "============================================================"
Write-Host " STAGE 5 / WARP TIME +25 HOURS"
Write-Host "============================================================"
$beforeTs = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$deadline = ((cast call $HOOK "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "before block.ts  : $beforeTs"
Write-Host "genesisDeadline  : $deadline"

# increase time by 25 hours = 90,000 seconds
[void](cast rpc evm_increaseTime 90000 --rpc-url $ANVIL)
# mine one block to commit
[void](cast rpc evm_mine --rpc-url $ANVIL)

$afterTs = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "after  block.ts  : $afterTs"
$dt = [int64]$afterTs - [int64]$beforeTs
Write-Host "delta            : $dt seconds"
$passDeadline = ([int64]$afterTs -gt [int64]$deadline)
Write-Host "past deadline    : $passDeadline"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 6 / PRE-LAUNCH STATE CHECK"
Write-Host "============================================================"
$launched = ((cast call $HOOK "launched()(bool)" --rpc-url $ANVIL).Trim())
$total    = ((cast call $HOOK "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$cap      = ((cast call $HOOK "softCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "launched()       : $launched"
Write-Host "totalDeposited   : $total"
Write-Host "softCap          : $cap"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 7 / CREATOR CALLS launch()"
Write-Host "============================================================"
$out = cast send $HOOK "launch()" --rpc-url $ANVIL --private-key $DKEY --gas-limit 10000000 2>&1
$st  = ($out | Select-String "^status").Line
$gas = ($out | Select-String "^gasUsed").Line
$txh = ($out | Select-String "^transactionHash").Line
Write-Host "launch tx        : $st"
Write-Host "$gas"
Write-Host "$txh"

if ($out -match "execution reverted") {
    Write-Host "FULL ERROR:"
    Write-Host $out
}

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 8 / POST-LAUNCH STATE"
Write-Host "============================================================"
$launched = ((cast call $HOOK "launched()(bool)" --rpc-url $ANVIL).Trim())
Write-Host "launched()         : $launched"

$snap = ((cast call $HOOK "snappedPlatformTreasury()(address)" --rpc-url $ANVIL).Trim())
Write-Host "snappedPlatformTreasury: $snap"

# read the token address from factory
$lInfo = (cast call $FACTORY "launches(uint256)(address,address,address,uint256)" 0 --rpc-url $ANVIL).Trim()
Write-Host "launches[0] tuple:"
Write-Host $lInfo

# Try to read hook fields that are populated after launch
$proAdmin = ((cast call $HOOK "projectAdmin()(address)" --rpc-url $ANVIL).Trim())
Write-Host "projectAdmin       : $proAdmin"

$cre = ((cast call $HOOK "creator()(address)" --rpc-url $ANVIL).Trim())
Write-Host "creator            : $cre"
