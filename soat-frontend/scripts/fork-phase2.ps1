$ErrorActionPreference = "Stop"
$ANVIL    = "http://127.0.0.1:8545"
$DKEY     = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$DEPLOYER = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$FACTORY  = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO     = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"
$HOOK     = "0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7"
$TOKEN    = "0xDbBE8a55375d93113c766Ad98940D4c3311a6E3c"
$TREASURY = "0x52660B62fa29d7e0a3aBc345eB330D18F8768a7e"

# Load W2 from prior stage
$w2 = Get-Content -Path "$PSScriptRoot\..\..\.fork-w2.json" -Raw | ConvertFrom-Json
$W2_ADDR = $w2.w2_addr
$W2_KEY  = $w2.w2_key
Write-Host "Loaded W2 from .fork-w2.json: $W2_ADDR"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 9 / GENERATE W3 BUYER + FUND"
Write-Host "============================================================"
$w3 = (cast wallet new --json) | ConvertFrom-Json
$W3_ADDR = $w3[0].address
$W3_KEY  = $w3[0].private_key
Write-Host "W3 ADDR : $W3_ADDR"
[void](cast rpc anvil_setBalance $W3_ADDR 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $W3_ADDR 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$ethBal  = ((cast balance $W3_ADDR --rpc-url $ANVIL).Trim())
$satoBal = ((cast call $SATO "balanceOf(address)(uint256)" $W3_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "W3 ETH  : $ethBal"
Write-Host "W3 SATO : $satoBal (100 SATO)"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 10 / PRE-MINT STATE SNAPSHOT"
Write-Host "============================================================"
$treasurySatoBefore = ((cast call $SATO "balanceOf(address)(uint256)" $TREASURY --rpc-url $ANVIL).Trim() -split " ")[0]
$hookSatoBefore     = ((cast call $SATO "balanceOf(address)(uint256)" $HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyBefore  = ((cast call $TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$p0                 = ((cast call $HOOK "p0()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$bondedBefore       = ((cast call $HOOK "phase2Minted()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "treasury SATO    : $treasurySatoBefore"
Write-Host "hook SATO        : $hookSatoBefore"
Write-Host "token totalSupply: $tokenSupplyBefore"
Write-Host "p0 (sato-wei/token-wei): $p0"
Write-Host "phase2Minted     : $bondedBefore"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 11 / W3 mintBondingCurve(1000 tokens)"
Write-Host "============================================================"
$tokenAmt = "1000000000000000000000" # 1000 tokens
$maxCost  = "100000000000000000000"  # 100 SATO max (very generous)
[void](cast send $SATO "approve(address,uint256)" $HOOK $maxCost --rpc-url $ANVIL --private-key $W3_KEY)
$out = cast send $HOOK "mintBondingCurve(uint256,uint256)" $tokenAmt $maxCost --rpc-url $ANVIL --private-key $W3_KEY --gas-limit 1000000 2>&1
$st  = ($out | Select-String "^status").Line
$gas = ($out | Select-String "^gasUsed").Line
Write-Host "mintBondingCurve : $st"
Write-Host "$gas"
if ($out -match "execution reverted") { Write-Host "REVERT MSG:"; Write-Host $out }

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 12 / POST-MINT STATE COMPARISON"
Write-Host "============================================================"
$treasurySatoAfter = ((cast call $SATO "balanceOf(address)(uint256)" $TREASURY --rpc-url $ANVIL).Trim() -split " ")[0]
$hookSatoAfter     = ((cast call $SATO "balanceOf(address)(uint256)" $HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyAfter  = ((cast call $TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$bondedAfter       = ((cast call $HOOK "phase2Minted()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$w3TokenBal        = ((cast call $TOKEN "balanceOf(address)(uint256)" $W3_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$w3SatoAfter       = ((cast call $SATO "balanceOf(address)(uint256)" $W3_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]

$treasuryDelta = [System.Numerics.BigInteger]::Parse($treasurySatoAfter) - [System.Numerics.BigInteger]::Parse($treasurySatoBefore)
$hookSatoDelta = [System.Numerics.BigInteger]::Parse($hookSatoAfter)     - [System.Numerics.BigInteger]::Parse($hookSatoBefore)
$supplyDelta   = [System.Numerics.BigInteger]::Parse($tokenSupplyAfter)  - [System.Numerics.BigInteger]::Parse($tokenSupplyBefore)
$bondedDelta   = [System.Numerics.BigInteger]::Parse($bondedAfter)       - [System.Numerics.BigInteger]::Parse($bondedBefore)

Write-Host "treasury SATO    +$treasuryDelta   (= 2% of total SATO paid)"
Write-Host "hook SATO        +$hookSatoDelta   (= 98% of total SATO paid)"
Write-Host "token supply     +$supplyDelta    (should = 1000 tokens minted = 1000e18)"
Write-Host "phase2Minted     +$bondedDelta"
Write-Host "W3 token balance : $w3TokenBal"
Write-Host "W3 SATO balance  : $w3SatoAfter (was 100 SATO, delta = SATO spent)"

# Verify the 2% / 98% split
$totalSato = $treasuryDelta + $hookSatoDelta
if ($totalSato -gt 0) {
    $pct = ($treasuryDelta * 10000) / $totalSato
    Write-Host "treasury share   : $pct / 10000 (bp)"
}

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 13 / W2 claimGenesis"
Write-Host "============================================================"
$w2TokenBefore = ((cast call $TOKEN "balanceOf(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$hasClaimedBefore = ((cast call $HOOK "hasClaimed(address)(bool)" $W2_ADDR --rpc-url $ANVIL).Trim())
Write-Host "W2 token balance (before): $w2TokenBefore"
Write-Host "W2 hasClaimed (before)   : $hasClaimedBefore"

$out = cast send $HOOK "claimGenesis()" --rpc-url $ANVIL --private-key $W2_KEY --gas-limit 500000 2>&1
$st  = ($out | Select-String "^status").Line
$gas = ($out | Select-String "^gasUsed").Line
Write-Host "claimGenesis     : $st"
Write-Host "$gas"

$w2TokenAfter = ((cast call $TOKEN "balanceOf(address)(uint256)" $W2_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$hasClaimedAfter = ((cast call $HOOK "hasClaimed(address)(bool)" $W2_ADDR --rpc-url $ANVIL).Trim())
Write-Host "W2 token balance (after) : $w2TokenAfter"
Write-Host "W2 hasClaimed (after)    : $hasClaimedAfter"

# expected: 2,100,000 * (7994/8000) = 2,098,425 tokens
$expected = [System.Numerics.BigInteger]::Parse("2100000000000000000000000") * [System.Numerics.BigInteger]::Parse("7994000000000000000000") / [System.Numerics.BigInteger]::Parse("8000000000000000000000")
Write-Host "Expected claim   : $expected (= 2.1M * 7994/8000)"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 14 / projectAdmin (deployer) harvestAndBurn"
Write-Host "============================================================"
$hookSatoPreHarvest = ((cast call $SATO "balanceOf(address)(uint256)" $HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyPreHarvest = ((cast call $TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "hook SATO (curve fees pending burn): $hookSatoPreHarvest"
Write-Host "token totalSupply pre-harvest      : $tokenSupplyPreHarvest"

# harvestAndBurn(minSatoOut, minTokensBought) — passing 0,0 means no slippage gate
$out = cast send $HOOK "harvestAndBurn(uint256,uint256)" 0 0 --rpc-url $ANVIL --private-key $DKEY --gas-limit 1000000 2>&1
$st  = ($out | Select-String "^status").Line
$gas = ($out | Select-String "^gasUsed").Line
Write-Host "harvestAndBurn   : $st"
Write-Host "$gas"
if ($out -match "execution reverted") { Write-Host "REVERT MSG:"; Write-Host $out }

$hookSatoPostHarvest = ((cast call $SATO "balanceOf(address)(uint256)" $HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyPostHarvest = ((cast call $TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "hook SATO post           : $hookSatoPostHarvest"
Write-Host "token totalSupply post   : $tokenSupplyPostHarvest"
$supplyDeltaHarvest = [System.Numerics.BigInteger]::Parse($tokenSupplyPreHarvest) - [System.Numerics.BigInteger]::Parse($tokenSupplyPostHarvest)
Write-Host "tokens burned via harvest: $supplyDeltaHarvest"

# also persist W3 to file for later use
@{ w3_addr = $W3_ADDR; w3_key = $W3_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-w3.json"
