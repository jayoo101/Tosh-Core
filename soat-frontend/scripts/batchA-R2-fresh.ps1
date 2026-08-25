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
        Write-Host ("  {0,-55} -> reverted {1}  {2}" -f $label, $sel, $name)
    } elseif ($s -match "execution reverted:?\s*([^,\r\n]*)") {
        Write-Host ("  {0,-55} -> reverted ""{1}""" -f $label, $matches[1].Trim().Trim('"'))
    } elseif ($s -match "status\s+1") {
        Write-Host ("  {0,-55} -> STATUS 1" -f $label)
    } else {
        Write-Host ("  {0,-55} -> {1}" -f $label, ($out | Select-Object -First 1))
    }
}

Write-Host "============================================================"
Write-Host " R2 (retry on FRESH launch) / cooldownDuration > 0"
Write-Host "============================================================"

# Make sure cap & cooldown setters back to defaults first
[void](cast send $F "setDefaultSoftCap(uint256)" 8000000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
[void](cast send $F "setCooldownDuration(uint256)" 3600 --rpc-url $ANVIL --private-key $DKEY)
$cd = ((cast call $F "cooldownDuration()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  cooldownDuration = $cd"

# 1. Build fresh creator and deploy JJJ launch
$cw = (cast wallet new --json) | ConvertFrom-Json
$C = $cw[0].address; $C_KEY = $cw[0].private_key
[void](cast rpc anvil_setBalance $C 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $C 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

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
[void](cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" "JJJ" "JJJ" $C $C $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $C_KEY --gas-limit 6000000)
$count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$tup = (cast call $F "launches(uint256)(address,address,address,uint256)" ([int]$count - 1) --rpc-url $ANVIL).Trim() -split "\s+"
$JJJ = $tup[1]
Write-Host "  JJJ hook = $JJJ"
$dl = ((cast call $JJJ "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  JJJ deadline = $dl, now = $now, remaining = $([int64]$dl - [int64]$now)s"

# 2. Fresh wallet R, PoG quota 5 SATO, balance 5 SATO
$rw = (cast wallet new --json) | ConvertFrom-Json
$R = $rw[0].address; $R_KEY = $rw[0].private_key
[void](cast rpc anvil_setBalance $R 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $R 5000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

$dlSig = ([int64]$now + 3600).ToString()
$ma  = "5000000000000000000"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $R $ma 0 $dlSig $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $ma $dlSig 0 $sig --rpc-url $ANVIL --private-key $R_KEY)
[void](cast send $SATO "approve(address,uint256)" $F 5000000000000000000 --rpc-url $ANVIL --private-key $R_KEY)

# 3. 1st deposit (must succeed, sets cooldown)
$out = cast send $F "deposit(address,uint256)" $JJJ 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "1st deposit 1 SATO" $out
$cdEnd = ((cast call $F "userLaunchCooldownEnd(address,address)(uint256)" $R $JJJ --rpc-url $ANVIL).Trim() -split " ")[0]
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  cooldownEnd[R,JJJ] = $cdEnd  (remaining=$([int64]$cdEnd - [int64]$now2)s)"

# 4. Immediate 2nd deposit (must revert CooldownActive 0xaa9a98df)
$out = cast call --from $R $F "deposit(address,uint256)" $JJJ 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "2nd deposit during cooldown" $out

# 5. Warp +30 min (still locked)
[void](cast rpc evm_increaseTime 1800 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  +30min: remaining=$([int64]$cdEnd - [int64]$now2)s"
$out = cast call --from $R $F "deposit(address,uint256)" $JJJ 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit at cooldown-mid (still locked)" $out

# 6. Warp another 31 min (cleared)
[void](cast rpc evm_increaseTime 1860 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  +61min: past cooldownEnd by $([int64]$now2 - [int64]$cdEnd)s"
$out = cast send $F "deposit(address,uint256)" $JJJ 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit after cooldown lift" $out

# Restore
[void](cast send $F "setCooldownDuration(uint256)" 0 --rpc-url $ANVIL --private-key $DKEY)
Write-Host ""
Write-Host "BATCH A retry done."
