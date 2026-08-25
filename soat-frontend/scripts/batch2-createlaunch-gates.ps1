$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"
$BURN  = "0x000000000000000000000000000000000000dEaD"

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

Write-Host "------------------------------------------------------------"
Write-Host "L1 / createLaunch INVALID HOOK SALT (raw=0x00...01, will fail mining check)"
Write-Host "------------------------------------------------------------"
# approve fee
[void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$badSalt = "0x" + ("0" * 63) + "1"
$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $D $D $badSalt 50000000000000000000 --rpc-url $ANVIL 2>&1
Report "salt=0x01 (untuned address flags)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L2 / createLaunch FEE MISMATCH (expectedFee < launchFee)"
Write-Host "------------------------------------------------------------"
$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $D $D ("0x" + ("0" * 64)) 1 --rpc-url $ANVIL 2>&1
Report "expectedFee=1 (real fee 50e18)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L3 / createLaunch projectAdmin=0"
Write-Host "------------------------------------------------------------"
$zero = "0x0000000000000000000000000000000000000000"
$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $D $zero ("0x" + ("0" * 64)) 50000000000000000000 --rpc-url $ANVIL 2>&1
Report "projectAdmin=0x0" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L4 / createLaunch projectTreasury=0"
Write-Host "------------------------------------------------------------"
$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $zero $D ("0x" + ("0" * 64)) 50000000000000000000 --rpc-url $ANVIL 2>&1
Report "projectTreasury=0x0" $out

# Now deploy a real CCC launch for M8 + M11 tests
Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "Setup / deploy CCC launch (mine salt for D)"
Write-Host "------------------------------------------------------------"
$cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$initHash = ((cast call $F "hookInitcodeHash(address,address,address,uint256)(bytes32)" $D $D $D $cap --rpc-url $ANVIL).Trim())
$found = $false
for ($i = 0; $i -lt 500; $i++) {
    $rawSalt = "0x" + ("{0:x64}" -f $i)
    $pred = ((cast call $F "predictHookAddress(address,bytes32,bytes32)(address)" $D $rawSalt $initHash --rpc-url $ANVIL).Trim()).ToLower()
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
[void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$out = cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" "CCC" "CCC" $D $D $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $DKEY --gas-limit 6000000 2>&1
Report "CCC createLaunch" $out
$count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$tup = (cast call $F "launches(uint256)(address,address,address,uint256)" ([int]$count - 1) --rpc-url $ANVIL).Trim() -split "\s+"
$CCC_HOOK = $tup[1]
Write-Host "  CCC hook = $CCC_HOOK"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M11 / launch() called by NON-CREATOR"
Write-Host "------------------------------------------------------------"
$w = (cast wallet new --json) | ConvertFrom-Json
$X = $w[0].address; $X_KEY = $w[0].private_key
[void](cast rpc anvil_setBalance $X 0xde0b6b3a7640000 --rpc-url $ANVIL)
$out = cast call --from $X $CCC_HOOK "launch()" --rpc-url $ANVIL 2>&1
Report "launch() from random wallet" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M8 / LaunchWindowExpired (warp +8 days)"
Write-Host "------------------------------------------------------------"
# We need to fill the softCap first because launch() checks order:
#   OnlyCreator → GenesisActive → AlreadyLaunched → SoftCapNotMet → ZeroAmount → LaunchWindowExpired
# So to actually trigger LaunchWindowExpired we need softCap met first.

# fund a new wallet and fill 8000 SATO
$w = (cast wallet new --json) | ConvertFrom-Json
$Y = $w[0].address; $Y_KEY = $w[0].private_key
[void](cast rpc anvil_setBalance $Y 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $Y 8000000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
# registerPoG for 8000 SATO
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
Write-Host "  CCC totalDeposited = $cTotal (softCap met)"

# warp +8 days = 691200s
[void](cast rpc evm_increaseTime 691200 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl2  = ((cast call $CCC_HOOK "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  now=$now2  deadline=$dl2  delta=$([int64]$now2 - [int64]$dl2) s (LAUNCH_WINDOW=604800)"
$out = cast call --from $D $CCC_HOOK "launch()" --rpc-url $ANVIL 2>&1
Report "launch() after 8 days" $out

# persist CCC hook for batch6 (refund zombieExpired)
@{ ccc_hook = $CCC_HOOK; y_addr = $Y; y_key = $Y_KEY } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-ccc.json"
