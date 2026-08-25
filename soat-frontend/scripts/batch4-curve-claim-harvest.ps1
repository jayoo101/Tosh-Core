$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

function Report($label, $out) {
    if ($null -eq $out) { Write-Host ("  {0,-50} → (null)" -f $label); return }
    $s = ($out | Out-String)
    if ($s -match "data: ""(0x[0-9a-fA-F]{8,})""") {
        $sel = $matches[1].Substring(0,10)
        $name = ((cast 4byte $sel 2>&1) -join " ").Trim()
        if ($name -match "No matching") { $name = "(custom)" }
        Write-Host ("  {0,-50} → reverted {1}  {2}" -f $label, $sel, $name)
    } elseif ($s -match "execution reverted:?\s*([^,\r\n]*)") {
        $reason = $matches[1].Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($reason)) { $reason = "(no reason)" }
        Write-Host ("  {0,-50} → reverted ""{1}""" -f $label, $reason)
    } elseif ($s -match "status\s+1") {
        Write-Host ("  {0,-50} → STATUS 1" -f $label)
    } else {
        $first = ($out | Select-Object -First 1).ToString().Trim()
        Write-Host ("  {0,-50} → {1}" -f $label, $first)
    }
}

function DeployLaunch([string]$name, [string]$creator, [string]$creator_key) {
    $cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
    $initHash = ((cast call $F "hookInitcodeHash(address,address,address,uint256)(bytes32)" $creator $creator $creator $cap --rpc-url $ANVIL).Trim())
    $rawSalt = ""
    for ($i = 0; $i -lt 5000; $i++) {
        $rs = "0x" + ("{0:x64}" -f $i)
        $pred = ((cast call $F "predictHookAddress(address,bytes32,bytes32)(address)" $creator $rs $initHash --rpc-url $ANVIL).Trim()).ToLower()
        $low = [Convert]::ToInt32($pred.Substring($pred.Length - 4), 16)
        if (($low -band 0x2200) -eq 0x2200) {
            $b0=($low -band 1); $b1=($low -band 2); $b2=($low -band 4); $b3=($low -band 8)
            if ($b0 -ne 0 -and ($low -band 0x100) -eq 0) { continue }
            if ($b1 -ne 0 -and ($low -band 0x400) -eq 0) { continue }
            if ($b2 -ne 0 -and ($low -band 0x40)  -eq 0) { continue }
            if ($b3 -ne 0 -and ($low -band 0x80)  -eq 0) { continue }
            $rawSalt = $rs; break
        }
    }
    [void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $creator_key)
    [void](cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" $name $name $creator $creator $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $creator_key --gas-limit 6000000)
    $count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
    $tup = (cast call $F "launches(uint256)(address,address,address,uint256)" ([int]$count - 1) --rpc-url $ANVIL).Trim() -split "\s+"
    return @($tup[0], $tup[1])  # token, hook
}

function NewWallet([string]$satoAmount) {
    $w = (cast wallet new --json) | ConvertFrom-Json
    $a = $w[0].address; $kk = $w[0].private_key
    [void](cast rpc anvil_setBalance $a 0xde0b6b3a7640000 --rpc-url $ANVIL)
    [void](cast send $SATO "transfer(address,uint256)" $a $satoAmount --rpc-url $ANVIL --private-key $DKEY)
    return @($a, $kk)
}

function RegisterPoG([string]$user, [string]$user_key, [string]$maxAllocWei) {
    $n = ((cast call $F "pogNonces(address)(uint256)" $user --rpc-url $ANVIL).Trim() -split " ")[0]
    $now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
    $dl  = ([int64]$now + 3600).ToString()
    $enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $user $maxAllocWei $n $dl $F 84532).Trim()
    $inner = (cast keccak $enc).Trim()
    $sig = (cast wallet sign --private-key $DKEY $inner).Trim()
    [void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAllocWei $dl $n $sig --rpc-url $ANVIL --private-key $user_key)
}

# Setup: deploy FFF launch, fill cap, launch into PHASE 2
$creator = NewWallet "100000000000000000000"  # 100 SATO for launch fee
$C = $creator[0]; $C_KEY = $creator[1]
$res = DeployLaunch "FFF" $C $C_KEY
$FFF_TOKEN = $res[0]; $FFF_HOOK = $res[1]
Write-Host "FFF token = $FFF_TOKEN  hook = $FFF_HOOK"

$contributor = NewWallet "9000000000000000000000"  # 9000 SATO
$P = $contributor[0]; $P_KEY = $contributor[1]
RegisterPoG $P $P_KEY 8000000000000000000000
[void](cast send $SATO "approve(address,uint256)" $F 8000000000000000000000 --rpc-url $ANVIL --private-key $P_KEY)
[void](cast send $F "deposit(address,uint256)" $FFF_HOOK 8000000000000000000000 --rpc-url $ANVIL --private-key $P_KEY)
$fillState = ((cast call $FFF_HOOK "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "FFF filled: $fillState SATO"

# warp +25h to allow launch
[void](cast rpc evm_increaseTime 90000 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$out = cast send $FFF_HOOK "launch()" --rpc-url $ANVIL --private-key $C_KEY --gas-limit 10000000 2>&1
Report "FFF launch()" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I1 / mintBondingCurve SINGLE-PURCHASE CAP (MAX_SINGLE_PURCHASE = BONDING_MAX/20 = 840,000 tokens)"
Write-Host "------------------------------------------------------------"
$buyer = NewWallet "50000000000000000000000"  # 50,000 SATO
$B = $buyer[0]; $B_KEY = $buyer[1]
[void](cast send $SATO "approve(address,uint256)" $FFF_HOOK 50000000000000000000000 --rpc-url $ANVIL --private-key $B_KEY)
$over1 = "840001000000000000000000"  # 840,001 tokens > MAX_SINGLE_PURCHASE
$out = cast call --from $B $FFF_HOOK "mintBondingCurve(uint256,uint256)" $over1 50000000000000000000000 --rpc-url $ANVIL 2>&1
Report "mint 840,001 (> MAX_SINGLE_PURCHASE)" $out
# Try exactly the cap (840,000) — should succeed
$exact = "840000000000000000000000"
$out = cast send $FFF_HOOK "mintBondingCurve(uint256,uint256)" $exact 50000000000000000000000 --rpc-url $ANVIL --private-key $B_KEY --gas-limit 1500000 2>&1
Report "mint 840,000 (= MAX_SINGLE_PURCHASE)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I3 / SLIPPAGE TRIP (maxSatoCost too low)"
Write-Host "------------------------------------------------------------"
$buyer2 = NewWallet "100000000000000000000"  # 100 SATO
$B2 = $buyer2[0]; $B2_KEY = $buyer2[1]
[void](cast send $SATO "approve(address,uint256)" $FFF_HOOK 100000000000000000000 --rpc-url $ANVIL --private-key $B2_KEY)
$out = cast call --from $B2 $FFF_HOOK "mintBondingCurve(uint256,uint256)" 1000000000000000000000 1 --rpc-url $ANVIL 2>&1
Report "buy 1000 tokens with maxCost=1 wei" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I4 / harvestAndBurn UNAUTHORIZED CALLER"
Write-Host "------------------------------------------------------------"
$out = cast call --from $B $FFF_HOOK "harvestAndBurn(uint256,uint256)" 0 0 --rpc-url $ANVIL 2>&1
Report "harvest by random buyer" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I5 / harvestAndBurn after 10 mints (real fee accumulation)"
Write-Host "------------------------------------------------------------"
# do 10 mints from B2 to accumulate LP fees
for ($k = 0; $k -lt 10; $k++) {
    [void](cast send $FFF_HOOK "mintBondingCurve(uint256,uint256)" 1000000000000000000000 50000000000000000000 --rpc-url $ANVIL --private-key $B2_KEY --gas-limit 1500000)
}
$hookSatoBefore = ((cast call $SATO "balanceOf(address)(uint256)" $FFF_HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyBefore = ((cast call $FFF_TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  hook SATO     before: $hookSatoBefore"
Write-Host "  token supply  before: $tokenSupplyBefore"
$out = cast send $FFF_HOOK "harvestAndBurn(uint256,uint256)" 0 0 --rpc-url $ANVIL --private-key $C_KEY --gas-limit 2000000 2>&1
Report "projectAdmin harvest(0,0)" $out
$hookSatoAfter = ((cast call $SATO "balanceOf(address)(uint256)" $FFF_HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$tokenSupplyAfter = ((cast call $FFF_TOKEN "totalSupply()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$burned = [System.Numerics.BigInteger]::Parse($tokenSupplyBefore) - [System.Numerics.BigInteger]::Parse($tokenSupplyAfter)
Write-Host "  hook SATO     after : $hookSatoAfter"
Write-Host "  token supply  after : $tokenSupplyAfter"
Write-Host "  tokens BURNED       : $burned"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I6 / harvest InsufficientBurnYield (minTokensBought too high)"
Write-Host "------------------------------------------------------------"
# do more mints
for ($k = 0; $k -lt 5; $k++) {
    [void](cast send $FFF_HOOK "mintBondingCurve(uint256,uint256)" 1000000000000000000000 50000000000000000000 --rpc-url $ANVIL --private-key $B2_KEY --gas-limit 1500000)
}
$out = cast call --from $C $FFF_HOOK "harvestAndBurn(uint256,uint256)" 0 1000000000000000000000000 --rpc-url $ANVIL 2>&1
Report "harvest with minBurn=1M tokens (impossible)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I7 / claimGenesis DOUBLE-CLAIM"
Write-Host "------------------------------------------------------------"
[void](cast send $FFF_HOOK "claimGenesis()" --rpc-url $ANVIL --private-key $P_KEY --gas-limit 500000)
$tok = ((cast call $FFF_TOKEN "balanceOf(address)(uint256)" $P --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  P claimed $tok tokens"
$out = cast call --from $P $FFF_HOOK "claimGenesis()" --rpc-url $ANVIL 2>&1
Report "P claimGenesis again" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I8 / claimGenesis by NON-DEPOSITOR (random wallet)"
Write-Host "------------------------------------------------------------"
$nondep = NewWallet "1"
$ND = $nondep[0]
$out = cast call --from $ND $FFF_HOOK "claimGenesis()" --rpc-url $ANVIL 2>&1
Report "claim by random wallet (no deposit)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I10 / changeProjectAdmin rotation"
Write-Host "------------------------------------------------------------"
$newAdminW = NewWallet "1"
$NA = $newAdminW[0]
$out = cast send $FFF_HOOK "changeProjectAdmin(address)" $NA --rpc-url $ANVIL --private-key $C_KEY 2>&1
Report "creator changes admin to $NA" $out
$curAdm = (cast call $FFF_HOOK "projectAdmin()(address)" --rpc-url $ANVIL).Trim()
Write-Host "  new projectAdmin = $curAdm"
# Old admin (creator) should now be unauthorized to harvest
$out = cast call --from $C $FFF_HOOK "harvestAndBurn(uint256,uint256)" 0 0 --rpc-url $ANVIL 2>&1
Report "OLD admin (creator) tries harvest" $out
# New admin can harvest
$out = cast call --from $NA $FFF_HOOK "harvestAndBurn(uint256,uint256)" 0 0 --rpc-url $ANVIL 2>&1
Report "NEW admin tries harvest" $out

# persist FFF state for batch5/6
@{ fff_token = $FFF_TOKEN; fff_hook = $FFF_HOOK; creator = $C; creator_key = $C_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-fff.json"
