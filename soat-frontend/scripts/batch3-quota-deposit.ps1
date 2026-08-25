$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

# Snapshot before this batch so we can roll back time-warp side-effects after
$snap = (cast rpc evm_snapshot --rpc-url $ANVIL).Trim().Trim('"')
Write-Host "anvil snapshot id = $snap"

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

# Setup: fresh wallet R with pogQuota = 100 SATO, 50 SATO available SATO balance
$w = (cast wallet new --json) | ConvertFrom-Json
$R = $w[0].address; $R_KEY = $w[0].private_key
[void](cast rpc anvil_setBalance $R 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $R 500000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl  = ([int64]$now + 3600).ToString()
$qa  = "100000000000000000000"  # 100 SATO quota
$n = "0"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $R $qa $n $dl $F 84532).Trim()
$inner = (cast keccak $enc).Trim(); $sig = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $qa $dl $n $sig --rpc-url $ANVIL --private-key $R_KEY)
[void](cast send $SATO "approve(address,uint256)" $F 500000000000000000000 --rpc-url $ANVIL --private-key $R_KEY)

# Use the AAA hook from Real chain (still in PHASE 1 in fork): 0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7
$AAA = "0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7"
$AAA_dl = ((cast call $AAA "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$AAA_total = ((cast call $AAA "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "AAA deadline: $AAA_dl  current total: $AAA_total"

Write-Host "------------------------------------------------------------"
Write-Host "M7 / deposit EXCEEDS own quota (deposit 200 SATO with quota 100)"
Write-Host "------------------------------------------------------------"
$out = cast call --from $R $F "deposit(address,uint256)" $AAA 200000000000000000000 --rpc-url $ANVIL 2>&1
Report "R deposit 200 SATO (quota=100)" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "M6 / CROSS-PROJECT QUOTA LOCK (H-01)"
Write-Host "    R deposits 60 SATO into AAA, then tries 60 SATO into CCC."
Write-Host "    Total 120 SATO > quota 100 → 2nd deposit must revert."
Write-Host "------------------------------------------------------------"
$ccc = (Get-Content -Path "$PSScriptRoot\..\..\.fork-ccc.json" -Raw | ConvertFrom-Json).ccc_hook
Write-Host "  CCC hook = $ccc"

$out1 = cast send $F "deposit(address,uint256)" $AAA 60000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "R deposit 60 SATO into AAA" $out1
$globAfter = ((cast call $F "totalGenesisDeposited(address)(uint256)" $R --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "    R globalCum = $globAfter"

$out2 = cast call --from $R $F "deposit(address,uint256)" $ccc 60000000000000000000 --rpc-url $ANVIL 2>&1
Report "R deposit 60 SATO into CCC (cross-project)" $out2

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "L8 / deposit AT exact genesisDeadline boundary"
Write-Host "    Warp to genesisDeadline - 1 → deposit must STATUS 1"
Write-Host "    Warp to genesisDeadline     → deposit must revert GenesisExpired"
Write-Host "------------------------------------------------------------"
# AAA deadline is far enough; jump within one second of it
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$skip = [int64]$AAA_dl - [int64]$now - 1
if ($skip -gt 0) {
    [void](cast rpc evm_increaseTime $skip --rpc-url $ANVIL)
    [void](cast rpc evm_mine --rpc-url $ANVIL)
}
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  now $now (deadline $AAA_dl, delta $([int64]$AAA_dl - [int64]$now))"
$out = cast send $F "deposit(address,uint256)" $AAA 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit 1 SATO at deadline-1" $out

# Now warp +2 → deadline reached, deposit must revert
[void](cast rpc evm_increaseTime 2 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  now $now (delta $([int64]$now - [int64]$AAA_dl))"
$out = cast call --from $R $F "deposit(address,uint256)" $AAA 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit 1 SATO at >= deadline" $out

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "I8 / claimGenesis by NON-DEPOSITOR (random wallet on AAA)"
Write-Host "    AAA is in PHASE 1 on fork — claim must revert NotLaunched first."
Write-Host "    To actually test NoDeposit we need a launched project."
Write-Host "    Use the LAUNCHED launch from previous fork session (we can't reuse)."
Write-Host "    Skipping until Batch 4 spins up a launched project."
Write-Host "------------------------------------------------------------"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "Restoring anvil snapshot to undo time warps"
Write-Host "------------------------------------------------------------"
$rev = (cast rpc evm_revert $snap --rpc-url $ANVIL).Trim()
Write-Host "evm_revert = $rev"
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "now after revert: $now"
