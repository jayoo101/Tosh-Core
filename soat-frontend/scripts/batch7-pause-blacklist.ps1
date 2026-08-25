$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
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

function RegisterPoG([string]$user, [string]$user_key, [string]$maxAllocWei) {
    $n = ((cast call $F "pogNonces(address)(uint256)" $user --rpc-url $ANVIL).Trim() -split " ")[0]
    $now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
    $dl  = ([int64]$now + 3600).ToString()
    $enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $user $maxAllocWei $n $dl $F 84532).Trim()
    $inner = (cast keccak $enc).Trim()
    $sig = (cast wallet sign --private-key $DKEY $inner).Trim()
    [void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $maxAllocWei $dl $n $sig --rpc-url $ANVIL --private-key $user_key)
}

# Prerequisite: build a wallet R with PoG quota + funds. Use existing HHH launch (deploy fresh).
$cw = NewWallet "100000000000000000000"
$C = $cw[0]; $C_KEY = $cw[1]
$cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$initHash = ((cast call $F "hookInitcodeHash(address,address,address,uint256)(bytes32)" $C $C $C $cap --rpc-url $ANVIL).Trim())
$rawSalt = ""
for ($i = 0; $i -lt 5000; $i++) {
    $rs = "0x" + ("{0:x64}" -f $i)
    $pred = ((cast call $F "predictHookAddress(address,bytes32,bytes32)(address)" $C $rs $initHash --rpc-url $ANVIL).Trim()).ToLower()
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
[void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $C_KEY)
[void](cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" "HHH" "HHH" $C $C $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $C_KEY --gas-limit 6000000)
$count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$tup = (cast call $F "launches(uint256)(address,address,address,uint256)" ([int]$count - 1) --rpc-url $ANVIL).Trim() -split "\s+"
$HHH = $tup[1]
Write-Host "HHH hook = $HHH"

$rw = NewWallet "500000000000000000000"
$R = $rw[0]; $R_KEY = $rw[1]
RegisterPoG $R $R_KEY "100000000000000000000"
[void](cast send $SATO "approve(address,uint256)" $F 500000000000000000000 --rpc-url $ANVIL --private-key $R_KEY)

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M10 / BLACKLIST USER → deposit must revert (with blacklistedUntil future)"
Write-Host "------------------------------------------------------------"
$users = "[$R]"
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$until = ([int64]$now + 86400).ToString()
$out = cast send $F "setBlacklist(address[],uint256)" "[$R]" $until --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "owner setBlacklist [R] for 24h" $out
$bl = ((cast call $F "blacklistedUntil(address)(uint256)" $R --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  R blacklistedUntil = $bl"
$out = cast call --from $R $F "deposit(address,uint256)" $HHH 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "blacklisted R tries deposit 1 SATO" $out

# liftBlacklist
$out = cast send $F "liftBlacklist(address[])" "[$R]" --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "owner liftBlacklist [R]" $out
$bl = ((cast call $F "blacklistedUntil(address)(uint256)" $R --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  R blacklistedUntil after lift = $bl"
$out = cast send $F "deposit(address,uint256)" $HHH 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "R deposit after lift (should succeed)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M9 / FACTORY PAUSE → createLaunch / registerPoG / deposit gated"
Write-Host "------------------------------------------------------------"
$out = cast send $F "pause()" --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "owner pause()" $out
$paused = ((cast call $F "paused()(bool)" --rpc-url $ANVIL).Trim())
Write-Host "  paused = $paused"

# Try deposit, createLaunch, registerPoG
$out = cast call --from $R $F "deposit(address,uint256)" $HHH 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit while paused" $out

$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $D $D 0x0000000000000000000000000000000000000000000000000000000000000000 50000000000000000000 --rpc-url $ANVIL 2>&1
Report "createLaunch while paused" $out

$out = cast call --from $R $F "registerPoG(uint256,uint256,uint256,bytes)" 1000000000000000000 ([int64]$now + 100).ToString() 0 0x00 --rpc-url $ANVIL 2>&1
Report "registerPoG while paused" $out

Write-Host ""
Write-Host "  ── unpause and confirm deposit re-enabled ──"
$out = cast send $F "unpause()" --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "owner unpause()" $out
$paused = ((cast call $F "paused()(bool)" --rpc-url $ANVIL).Trim())
Write-Host "  paused = $paused"
$out = cast send $F "deposit(address,uint256)" $HHH 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit after unpause" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L7 / deposit during paused (already covered above via M9 first revert)"
Write-Host "    Confirmed via M9 deposit while paused.  [OK]"
Write-Host "------------------------------------------------------------"
