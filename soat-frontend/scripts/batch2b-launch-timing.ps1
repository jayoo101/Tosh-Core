$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

function Report($label, $out) {
    if ($out -match "data: ""(0x[0-9a-fA-F]{8,})""") {
        $sel = $matches[1].Substring(0,10)
        $name = ((cast 4byte $sel 2>&1) -join " ").Trim()
        if ($name -match "No matching") { $name = "(custom err)" }
        Write-Host ("  {0,-44} → reverted {1}  {2}" -f $label, $sel, $name)
    } elseif ($out -match "execution reverted:\s*([^,]+)") {
        Write-Host ("  {0,-44} → reverted ""{1}""" -f $label, $matches[1].Trim().Trim('"'))
    } elseif ($out -match "status\s+1") {
        Write-Host ("  {0,-44} → STATUS 1" -f $label)
    } else {
        Write-Host ("  {0,-44} → {1}" -f $label, ($out | Select-Object -First 1))
    }
}

# Generate fresh creator C
$w = (cast wallet new --json) | ConvertFrom-Json
$C = $w[0].address; $C_KEY = $w[0].private_key
Write-Host "fresh creator C = $C"
[void](cast rpc anvil_setBalance $C 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $C 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

$cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$initHash = ((cast call $F "hookInitcodeHash(address,address,address,uint256)(bytes32)" $C $C $C $cap --rpc-url $ANVIL).Trim())
Write-Host "C initHash = $initHash"

$found = $false
for ($i = 0; $i -lt 5000; $i++) {
    $rawSalt = "0x" + ("{0:x64}" -f $i)
    $pred = ((cast call $F "predictHookAddress(address,bytes32,bytes32)(address)" $C $rawSalt $initHash --rpc-url $ANVIL).Trim()).ToLower()
    $lowHex = $pred.Substring($pred.Length - 4)
    $low = [Convert]::ToInt32($lowHex, 16)
    if (($low -band 0x2200) -eq 0x2200) {
        $b0 = ($low -band 1); $b1 = ($low -band 2); $b2 = ($low -band 4); $b3 = ($low -band 8)
        if ($b0 -ne 0 -and ($low -band 0x100) -eq 0) { continue }
        if ($b1 -ne 0 -and ($low -band 0x400) -eq 0) { continue }
        if ($b2 -ne 0 -and ($low -band 0x40)  -eq 0) { continue }
        if ($b3 -ne 0 -and ($low -band 0x80)  -eq 0) { continue }
        $found = $true; Write-Host ("  mined i=$i salt=$rawSalt addr=$pred"); break
    }
}
if (-not $found) { Write-Host "FAIL no salt"; exit 1 }

[void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $C_KEY)
$out = cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" "CCC" "CCC" $C $C $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $C_KEY --gas-limit 6000000 2>&1
Report "CCC createLaunch" $out

$count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$idx = [int]$count - 1
$tup = (cast call $F "launches(uint256)(address,address,address,uint256)" $idx --rpc-url $ANVIL).Trim() -split "\s+"
$CCC_HOOK = $tup[1]
Write-Host "  CCC hook = $CCC_HOOK"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M11 / launch() called by NON-CREATOR"
Write-Host "------------------------------------------------------------"
$out = cast call --from $D $CCC_HOOK "launch()" --rpc-url $ANVIL 2>&1
Report "launch() from deployer (not C)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M8 / LaunchWindowExpired (warp +8 days, fill softCap first)"
Write-Host "------------------------------------------------------------"
$w2 = (cast wallet new --json) | ConvertFrom-Json
$Y = $w2[0].address; $Y_KEY = $w2[0].private_key
[void](cast rpc anvil_setBalance $Y 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $Y 8000000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

$n = ((cast call $F "pogNonces(address)(uint256)" $Y --rpc-url $ANVIL).Trim() -split " ")[0]
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl  = ([int64]$now + 3600).ToString()
$ma  = "8000000000000000000000"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $Y $ma $n $dl $F 84532).Trim()
$inner = (cast keccak $enc).Trim(); $sig = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $ma $dl $n $sig --rpc-url $ANVIL --private-key $Y_KEY)
[void](cast send $SATO "approve(address,uint256)" $F $ma --rpc-url $ANVIL --private-key $Y_KEY)
[void](cast send $F "deposit(address,uint256)" $CCC_HOOK $ma --rpc-url $ANVIL --private-key $Y_KEY)
$cTotal = ((cast call $CCC_HOOK "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  CCC totalDeposited = $cTotal SATO (softCap met)"

# Warp +8 days = 691200s
[void](cast rpc evm_increaseTime 691200 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl2  = ((cast call $CCC_HOOK "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$delta = [int64]$now2 - [int64]$dl2
Write-Host "  now=$now2  deadline=$dl2  delta=$delta s (LAUNCH_WINDOW=604800)"
$out = cast call --from $C $CCC_HOOK "launch()" --rpc-url $ANVIL 2>&1
Report "creator launch() after 8d" $out

# Persist for batch6
@{ ccc_hook = $CCC_HOOK; ccreator = $C; ccreator_key = $C_KEY; y_addr = $Y; y_key = $Y_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-ccc.json"
