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
        Write-Host ("  {0,-50} → reverted {1}  {2}" -f $label, $sel, $name)
    } elseif ($out -match "execution reverted:\s*([^,]+)") {
        Write-Host ("  {0,-50} → reverted ""{1}""" -f $label, $matches[1].Trim().Trim('"'))
    } elseif ($out -match "status\s+1") {
        Write-Host ("  {0,-50} → STATUS 1" -f $label)
    } else {
        Write-Host ("  {0,-50} → {1}" -f $label, ($out | Select-Object -First 1))
    }
}

function MineSalt([string]$creator, [bytes32_unused]$initHash) { }

function DeployLaunch([string]$name, [string]$creator, [string]$creator_key) {
    $cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
    $initHash = ((cast call $F "hookInitcodeHash(address,address,address,uint256)(bytes32)" $creator $creator $creator $cap --rpc-url $ANVIL).Trim())
    $found = $false; $rawSalt = ""
    for ($i = 0; $i -lt 5000; $i++) {
        $rs = "0x" + ("{0:x64}" -f $i)
        $pred = ((cast call $F "predictHookAddress(address,bytes32,bytes32)(address)" $creator $rs $initHash --rpc-url $ANVIL).Trim()).ToLower()
        $lowHex = $pred.Substring($pred.Length - 4)
        $low = [Convert]::ToInt32($lowHex, 16)
        if (($low -band 0x2200) -eq 0x2200) {
            $b0 = ($low -band 1); $b1 = ($low -band 2); $b2 = ($low -band 4); $b3 = ($low -band 8)
            if ($b0 -ne 0 -and ($low -band 0x100) -eq 0) { continue }
            if ($b1 -ne 0 -and ($low -band 0x400) -eq 0) { continue }
            if ($b2 -ne 0 -and ($low -band 0x40)  -eq 0) { continue }
            if ($b3 -ne 0 -and ($low -band 0x80)  -eq 0) { continue }
            $found = $true; $rawSalt = $rs; break
        }
    }
    if (-not $found) { return $null }
    [void](cast send $SATO "approve(address,uint256)" $F 50000000000000000000 --rpc-url $ANVIL --private-key $creator_key)
    [void](cast send $F "createLaunch(string,string,address,address,bytes32,uint256)" $name $name $creator $creator $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $creator_key --gas-limit 6000000)
    $count = ((cast call $F "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
    $tup = (cast call $F "launches(uint256)(address,address,address,uint256)" ([int]$count - 1) --rpc-url $ANVIL).Trim() -split "\s+"
    return $tup[1]
}

# create two creators with funded SATO
$creators = @()
for ($k = 0; $k -lt 2; $k++) {
    $w = (cast wallet new --json) | ConvertFrom-Json
    $a = $w[0].address; $kk = $w[0].private_key
    [void](cast rpc anvil_setBalance $a 0xde0b6b3a7640000 --rpc-url $ANVIL)
    [void](cast send $SATO "transfer(address,uint256)" $a 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
    $creators += @{ addr = $a; key = $kk }
}

Write-Host "Deploying DDD..."
$DDD = DeployLaunch "DDD" $creators[0].addr $creators[0].key
Write-Host "  DDD hook = $DDD"
Write-Host "Deploying EEE..."
$EEE = DeployLaunch "EEE" $creators[1].addr $creators[1].key
Write-Host "  EEE hook = $EEE"

# Setup R: pogQuota 100 SATO, balance 500 SATO
$w = (cast wallet new --json) | ConvertFrom-Json
$R = $w[0].address; $R_KEY = $w[0].private_key
[void](cast rpc anvil_setBalance $R 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $R 500000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl  = ([int64]$now + 3600).ToString()
$qa  = "100000000000000000000"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $R $qa 0 $dl $F 84532).Trim()
$inner = (cast keccak $enc).Trim(); $sig = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $qa $dl 0 $sig --rpc-url $ANVIL --private-key $R_KEY)
[void](cast send $SATO "approve(address,uint256)" $F 500000000000000000000 --rpc-url $ANVIL --private-key $R_KEY)

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M6 / CROSS-PROJECT QUOTA LOCK"
Write-Host "    R quota = 100 SATO.  Deposits 60 into DDD, then 60 into EEE → 2nd must revert."
Write-Host "------------------------------------------------------------"
$out = cast send $F "deposit(address,uint256)" $DDD 60000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit 60 into DDD" $out
$g = ((cast call $F "totalGenesisDeposited(address)(uint256)" $R --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "    R globalCum = $g (should be 60e18)"
$out = cast call --from $R $F "deposit(address,uint256)" $EEE 60000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit 60 into EEE (60+60=120 > quota 100)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L8 / deposit AT BOUNDARY of genesisDeadline"
Write-Host "    Use DDD hook (deadline = ~ now+24h)."
Write-Host "------------------------------------------------------------"
$DDD_dl = ((cast call $DDD "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$nowB = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$skip = [int64]$DDD_dl - [int64]$nowB - 2
[void](cast rpc evm_increaseTime $skip --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$nowB = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dlt = [int64]$DDD_dl - [int64]$nowB
Write-Host "  now $nowB  deadline $DDD_dl  delta $dlt"

# Try deposit 1 SATO at deadline-2 (block timestamp +1 since each anvil_mine increments)
$out = cast send $F "deposit(address,uint256)" $DDD 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit 1 SATO before deadline" $out
$nowB = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dlt = [int64]$DDD_dl - [int64]$nowB
Write-Host "  now after $nowB  delta $dlt"

# warp past deadline
[void](cast rpc evm_increaseTime 5 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$nowB = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dlt = [int64]$nowB - [int64]$DDD_dl
Write-Host "  now $nowB (past deadline by $dlt s)"
$out = cast call --from $R $F "deposit(address,uint256)" $DDD 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit 1 SATO at >= deadline" $out

# Save EEE for potential later
@{ ddd = $DDD; eee = $EEE; ddd_creator = $creators[0].addr; ddd_key = $creators[0].key } | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\..\.fork-dde.json"
