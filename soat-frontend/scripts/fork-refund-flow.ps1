$ErrorActionPreference = "Stop"
$ANVIL    = "http://127.0.0.1:8545"
$DKEY     = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$DEPLOYER = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$FACTORY  = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO     = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"

Write-Host "============================================================"
Write-Host " STAGE 15 / GENERATE W4 (NEW CREATOR FOR BBB)"
Write-Host "============================================================"
$w4 = (cast wallet new --json) | ConvertFrom-Json
$W4_ADDR = $w4[0].address
$W4_KEY  = $w4[0].private_key
Write-Host "W4 ADDR : $W4_ADDR"
[void](cast rpc anvil_setBalance $W4_ADDR 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $W4_ADDR 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 16 / W4 CREATES BBB LAUNCH (softCap inherits factory.defaultSoftCap)"
Write-Host "============================================================"
# Need a valid mined salt for W4 + W4 (treasury) + W4 (admin) + factory.defaultSoftCap
$liveSoftCap = ((cast call $FACTORY "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "defaultSoftCap : $liveSoftCap"
$initHash = ((cast call $FACTORY "hookInitcodeHash(address,address,address,uint256)(bytes32)" $W4_ADDR $W4_ADDR $W4_ADDR $liveSoftCap --rpc-url $ANVIL).Trim())
Write-Host "initHash       : $initHash"

# Mine salt using forge inline helper — try simple iteration in PowerShell-friendly format
# We'll cast a HookMiner call instead.  Actually easier: just iterate i, compute finalSalt, compute addr, check flags.
# Faster: do it via the predictHookAddress view function.

$found = $false
for ($i = 0; $i -lt 500; $i++) {
    $rawSalt = "0x" + ("{0:x64}" -f $i)
    $pred = ((cast call $FACTORY "predictHookAddress(address,bytes32,bytes32)(address)" $W4_ADDR $rawSalt $initHash --rpc-url $ANVIL).Trim()).ToLower()
    # Last 14 bits of address must have bit 13 (0x2000) and bit 9 (0x0200) set
    $lowHex = $pred.Substring($pred.Length - 4)
    $low = [Convert]::ToInt32($lowHex, 16)
    if (($low -band 0x2200) -eq 0x2200) {
        # Verify delta-flag constraints
        $b0 = ($low -band 1)
        $b1 = ($low -band 2)
        $b2 = ($low -band 4)
        $b3 = ($low -band 8)
        if ($b0 -ne 0 -and ($low -band 0x100) -eq 0)  { continue }
        if ($b1 -ne 0 -and ($low -band 0x400) -eq 0)  { continue }
        if ($b2 -ne 0 -and ($low -band 0x40)  -eq 0)  { continue }
        if ($b3 -ne 0 -and ($low -band 0x80)  -eq 0)  { continue }
        $found = $true
        Write-Host "mined i=$i salt=$rawSalt addr=$pred"
        break
    }
}
if (-not $found) { Write-Host "FAIL: no salt"; exit 1 }

# W4 approves SATO for launchFee
[void](cast send $SATO "approve(address,uint256)" $FACTORY 50000000000000000000 --rpc-url $ANVIL --private-key $W4_KEY)
$out = cast send $FACTORY "createLaunch(string,string,address,address,bytes32,uint256)" "BBB" "BBB" $W4_ADDR $W4_ADDR $rawSalt 50000000000000000000 --rpc-url $ANVIL --private-key $W4_KEY --gas-limit 6000000 2>&1
$st  = ($out | Select-String "^status").Line
Write-Host "BBB createLaunch : $st"

$count = ((cast call $FACTORY "launchCount()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "factory.launchCount : $count"
$bbb = (cast call $FACTORY "launches(uint256)(address,address,address,uint256)" 1 --rpc-url $ANVIL).Trim() -split "\s+"
$BBB_TOKEN = $bbb[0]
$BBB_HOOK  = $bbb[1]
Write-Host "BBB token : $BBB_TOKEN"
Write-Host "BBB hook  : $BBB_HOOK"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 17 / W4 REGISTERS POG + DEPOSITS 3 SATO (way under 8000 softCap)"
Write-Host "============================================================"
$nonce = ((cast call $FACTORY "pogNonces(address)(uint256)" $W4_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$now      = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$deadline = ([int64]$now + 3600).ToString()
$maxAlloc = "3000000000000000000" # 3 SATO
$encoded = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $W4_ADDR $maxAlloc $nonce $deadline $FACTORY 84532).Trim()
$inner   = (cast keccak $encoded).Trim()
$sig     = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $FACTORY "registerPoG(uint256,uint256,uint256,bytes)" $maxAlloc $deadline $nonce $sig --rpc-url $ANVIL --private-key $W4_KEY)
[void](cast send $SATO "approve(address,uint256)" $FACTORY $maxAlloc --rpc-url $ANVIL --private-key $W4_KEY)
$out = cast send $FACTORY "deposit(address,uint256)" $BBB_HOOK $maxAlloc --rpc-url $ANVIL --private-key $W4_KEY 2>&1
$st  = ($out | Select-String "^status").Line
Write-Host "deposit 3 SATO : $st"

$totalBBB = ((cast call $BBB_HOOK "totalSatoDeposited()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$capBBB   = ((cast call $BBB_HOOK "softCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "BBB totalDeposited: $totalBBB"
Write-Host "BBB softCap       : $capBBB"
Write-Host "(intentionally NOT filling softCap so refund becomes available)"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 18 / WARP +25H (PAST genesisDeadline, softCap UNMET)"
Write-Host "============================================================"
[void](cast rpc evm_increaseTime 90000 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$deadlineBBB = ((cast call $BBB_HOOK "genesisDeadline()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
$canRefund = ((cast call $BBB_HOOK "canRefund()(bool)" --rpc-url $ANVIL).Trim())
Write-Host "now              : $now"
Write-Host "BBB deadline     : $deadlineBBB"
Write-Host "BBB canRefund()  : $canRefund"

Write-Host ""
Write-Host "============================================================"
Write-Host " STAGE 19 / W4 REFUNDS"
Write-Host "============================================================"
$w4SatoBefore = ((cast call $SATO "balanceOf(address)(uint256)" $W4_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$w4DepositBefore = ((cast call $BBB_HOOK "satoDeposited(address)(uint256)" $W4_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "W4 SATO before refund: $w4SatoBefore"
Write-Host "W4 deposit registered: $w4DepositBefore"

$out = cast send $BBB_HOOK "refund()" --rpc-url $ANVIL --private-key $W4_KEY --gas-limit 500000 2>&1
$st  = ($out | Select-String "^status").Line
$gas = ($out | Select-String "^gasUsed").Line
Write-Host "refund tx        : $st"
Write-Host "$gas"
if ($out -match "execution reverted") { Write-Host "REVERT MSG:"; Write-Host $out }

$w4SatoAfter = ((cast call $SATO "balanceOf(address)(uint256)" $W4_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$w4DepositAfter = ((cast call $BBB_HOOK "satoDeposited(address)(uint256)" $W4_ADDR --rpc-url $ANVIL).Trim() -split " ")[0]
$delta = [System.Numerics.BigInteger]::Parse($w4SatoAfter) - [System.Numerics.BigInteger]::Parse($w4SatoBefore)
Write-Host "W4 SATO after refund : $w4SatoAfter"
Write-Host "SATO returned        : $delta (should be 3 SATO = 3e18)"
Write-Host "W4 deposit zero'd    : $w4DepositAfter"

# Try double-refund — should revert AlreadyRefunded or zero amount
Write-Host ""
Write-Host "=== Attempt double refund (should revert) ==="
$out = cast call --from $W4_ADDR $BBB_HOOK "refund()" --rpc-url $ANVIL 2>&1
Write-Host ($out | Select-Object -First 2)
