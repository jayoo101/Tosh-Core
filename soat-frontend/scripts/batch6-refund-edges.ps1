$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

function Report($label, $out) {
    $s = ($out | Out-String)
    if ($s -match "data: ""(0x[0-9a-fA-F]{8,})""") {
        $sel = $matches[1].Substring(0,10)
        $name = ((cast 4byte $sel 2>&1) -join " ").Trim()
        if ($name -match "No matching") { $name = "(custom)" }
        Write-Host ("  {0,-50} → reverted {1}  {2}" -f $label, $sel, $name)
    } elseif ($s -match "execution reverted:?\s*([^,\r\n]*)") {
        Write-Host ("  {0,-50} → reverted ""{1}""" -f $label, $matches[1].Trim().Trim('"'))
    } elseif ($s -match "status\s+1") {
        Write-Host ("  {0,-50} → STATUS 1" -f $label)
    } else {
        Write-Host ("  {0,-50} → {1}" -f $label, ($out | Select-Object -First 1))
    }
}

function NewWallet([string]$satoAmount) {
    $w = (cast wallet new --json) | ConvertFrom-Json
    $a = $w[0].address; $kk = $w[0].private_key
    [void](cast rpc anvil_setBalance $a 0xde0b6b3a7640000 --rpc-url $ANVIL)
    [void](cast send $SATO "transfer(address,uint256)" $a $satoAmount --rpc-url $ANVIL --private-key $DKEY)
    return @($a, $kk)
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
    return $tup[1]
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

Write-Host "------------------------------------------------------------"
Write-Host "Setup / Deploy GGG with 8000 SATO softCap met but no launch()"
Write-Host "    Then warp +8 days → canRefund via zombieExpired"
Write-Host "------------------------------------------------------------"
$cw = NewWallet "100000000000000000000"
$C = $cw[0]; $C_KEY = $cw[1]
$GGG = DeployLaunch "GGG" $C $C_KEY
Write-Host "  GGG hook = $GGG"

# Fill cap so refund won't trigger via softCapFailed - we want zombieExpired path
$pw = NewWallet "9000000000000000000000"
$P = $pw[0]; $P_KEY = $pw[1]
RegisterPoG $P $P_KEY "8000000000000000000000"
[void](cast send $SATO "approve(address,uint256)" $F 8000000000000000000000 --rpc-url $ANVIL --private-key $P_KEY)
[void](cast send $F "deposit(address,uint256)" $GGG 8000000000000000000000 --rpc-url $ANVIL --private-key $P_KEY)
$total = ((cast call $GGG "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  GGG filled: $total SATO (softCap met but creator never calls launch)"

# Warp +8 days (past genesisDeadline + LAUNCH_WINDOW)
[void](cast rpc evm_increaseTime 691200 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$nowT = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl   = ((cast call $GGG "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$canRefund = ((cast call $GGG "canRefund()(bool)" --rpc-url $ANVIL).Trim())
Write-Host "  now=$nowT  deadline=$dl  delta=$([int64]$nowT - [int64]$dl) s  canRefund=$canRefund"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L5 / refund() ZOMBIE-EXPIRED PATH (softCap MET but no launch in 7+ days)"
Write-Host "------------------------------------------------------------"
$beforeBal = ((cast call $SATO "balanceOf(address)(uint256)" $P --rpc-url $ANVIL).Trim() -split " ")[0]
$out = cast send $GGG "refund()" --rpc-url $ANVIL --private-key $P_KEY --gas-limit 500000 2>&1
Report "P refund() (softCap met + 8d)" $out
$afterBal = ((cast call $SATO "balanceOf(address)(uint256)" $P --rpc-url $ANVIL).Trim() -split " ")[0]
$delta = [System.Numerics.BigInteger]::Parse($afterBal) - [System.Numerics.BigInteger]::Parse($beforeBal)
Write-Host "  SATO refunded: $delta (expected 8000e18)"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L6 / refund() by NON-DEPOSITOR"
Write-Host "------------------------------------------------------------"
$rw = NewWallet "1"
$R = $rw[0]; $R_KEY = $rw[1]
$out = cast call --from $R $GGG "refund()" --rpc-url $ANVIL 2>&1
Report "random wallet refund (never deposited)" $out
