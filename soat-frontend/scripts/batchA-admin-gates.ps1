$ErrorActionPreference = "Continue"
$ANVIL = "http://127.0.0.1:8545"
$DKEY  = "0x0c01489bc5a71166efff1dc281ce0a1e4a03e760e45e6f2fd77c56a0d57d06de"
$D     = "0x73db078fa94607893270079AC8F5c7492aB480cd"
$F     = "0xe7314e9Eb0736A906C56bA83B8039E2A00524CD1"
$SATO  = "0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc"
$HOOK  = "0xF55812e07DFa84ae4582bCEd8C07674B5a013FC7"  # AAA hook still PHASE 1 on fork

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
Write-Host " R4 / setDefaultSoftCap < MIN_SOFT_CAP_PROD (100 SATO)"
Write-Host "============================================================"
$min = ((cast call $F "MIN_SOFT_CAP_PROD()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  MIN_SOFT_CAP_PROD = $min  (100e18)"
# zero
$out = cast call --from $D $F "setDefaultSoftCap(uint256)" 0 --rpc-url $ANVIL 2>&1
Report "setDefaultSoftCap(0)" $out
# 99 SATO (just below floor)
$out = cast call --from $D $F "setDefaultSoftCap(uint256)" 99000000000000000000 --rpc-url $ANVIL 2>&1
Report "setDefaultSoftCap(99 SATO < MIN)" $out
# exactly 100 SATO (boundary, must pass)
$out = cast send $F "setDefaultSoftCap(uint256)" 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "setDefaultSoftCap(100 SATO == MIN)" $out
$cap = ((cast call $F "defaultSoftCap()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  defaultSoftCap now = $cap"
# Restore to 8000 SATO so later tests can use AAA params
[void](cast send $F "setDefaultSoftCap(uint256)" 8000000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

Write-Host ""
Write-Host "============================================================"
Write-Host " R3 / setLaunchFee bump -> stale expectedFee triggers FeeChanged"
Write-Host "============================================================"
$origFee = ((cast call $F "launchFee()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  launchFee original = $origFee  (50 SATO)"
# bump to 100 SATO
[void](cast send $F "setLaunchFee(uint256)" 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$newFee = ((cast call $F "launchFee()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  launchFee bumped   = $newFee  (100 SATO)"
# attempt createLaunch with stale expectedFee = 50 SATO  (still need approve etc but call is enough to reach gate)
[void](cast send $SATO "approve(address,uint256)" $F 100000000000000000000 --rpc-url $ANVIL --private-key $DKEY)
$out = cast call --from $D $F "createLaunch(string,string,address,address,bytes32,uint256)" "ZZZ" "ZZZ" $D $D 0x0000000000000000000000000000000000000000000000000000000000000000 50000000000000000000 --rpc-url $ANVIL 2>&1
Report "createLaunch expectedFee=50 (stale) launchFee=100" $out
# Restore
[void](cast send $F "setLaunchFee(uint256)" 50000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

Write-Host ""
Write-Host "============================================================"
Write-Host " R1 / setPogSigner rotation -> old signer's sig now InvalidSignature"
Write-Host "============================================================"
$origSigner = (cast call $F "pogSigner()(address)" --rpc-url $ANVIL).Trim()
Write-Host "  pogSigner before = $origSigner"
# Build a fresh signer wallet
$w = (cast wallet new --json) | ConvertFrom-Json
$NEW_SIGNER = $w[0].address
$NEW_SIGNER_KEY = $w[0].private_key
Write-Host "  new signer       = $NEW_SIGNER"

# Build user wallet A
$ua = (cast wallet new --json) | ConvertFrom-Json
$A = $ua[0].address; $A_KEY = $ua[0].private_key
[void](cast rpc anvil_setBalance $A 0xde0b6b3a7640000 --rpc-url $ANVIL)

# Pre-build TWO digests at the SAME nonce=0 and SAME deadline. Sign one with OLD key (DKEY = current signer),
# one with NEW key.
$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl  = ([int64]$now + 3600).ToString()
$ma  = "1000000000000000000"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $A $ma 0 $dl $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sigOld = (cast wallet sign --private-key $DKEY $inner).Trim()
$sigNew = (cast wallet sign --private-key $NEW_SIGNER_KEY $inner).Trim()

# Now rotate the signer
$out = cast send $F "setPogSigner(address)" $NEW_SIGNER --rpc-url $ANVIL --private-key $DKEY 2>&1
Report "setPogSigner(newSigner)" $out
$after = (cast call $F "pogSigner()(address)" --rpc-url $ANVIL).Trim()
Write-Host "  pogSigner after  = $after"

# Now old-sig should fail, new-sig should pass
$out = cast call --from $A $F "registerPoG(uint256,uint256,uint256,bytes)" $ma $dl 0 $sigOld --rpc-url $ANVIL 2>&1
Report "registerPoG with OLD signer's sig (post-rotate)" $out
$out = cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $ma $dl 0 $sigNew --rpc-url $ANVIL --private-key $A_KEY 2>&1
Report "registerPoG with NEW signer's sig" $out
$q = ((cast call $F "pogQuota(address)(uint256)" $A --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  A pogQuota = $q (1e18 expected)"
# Restore original signer
[void](cast send $F "setPogSigner(address)" $origSigner --rpc-url $ANVIL --private-key $DKEY)

Write-Host ""
Write-Host "============================================================"
Write-Host " R2 / cooldownDuration > 0 -> same wallet deposit twice blocked mid-cooldown"
Write-Host "============================================================"
# Set cooldown to 1 hour
[void](cast send $F "setCooldownDuration(uint256)" 3600 --rpc-url $ANVIL --private-key $DKEY)
$cd = ((cast call $F "cooldownDuration()(uint256)" --rpc-url $ANVIL).Trim() -split " ")[0]
Write-Host "  cooldownDuration = $cd  (3600s = 1h)"

# Use AAA hook (still PHASE 1). Build a fresh wallet R with PoG quota 5 SATO and 5 SATO balance.
$rw = (cast wallet new --json) | ConvertFrom-Json
$R = $rw[0].address; $R_KEY = $rw[0].private_key
[void](cast rpc anvil_setBalance $R 0xde0b6b3a7640000 --rpc-url $ANVIL)
[void](cast send $SATO "transfer(address,uint256)" $R 5000000000000000000 --rpc-url $ANVIL --private-key $DKEY)

$now = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
$dl  = ([int64]$now + 3600).ToString()
$ma  = "5000000000000000000"
$enc = (cast abi-encode "f(address,uint256,uint256,uint256,address,uint256)" $R $ma 0 $dl $F 84532).Trim()
$inner = (cast keccak $enc).Trim()
$sig = (cast wallet sign --private-key $DKEY $inner).Trim()
[void](cast send $F "registerPoG(uint256,uint256,uint256,bytes)" $ma $dl 0 $sig --rpc-url $ANVIL --private-key $R_KEY)
[void](cast send $SATO "approve(address,uint256)" $F 5000000000000000000 --rpc-url $ANVIL --private-key $R_KEY)

# Deposit 1 (must succeed)
$out = cast send $F "deposit(address,uint256)" $HOOK 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "1st deposit 1 SATO" $out
$cdEnd = ((cast call $F "userLaunchCooldownEnd(address,address)(uint256)" $R $HOOK --rpc-url $ANVIL).Trim() -split " ")[0]
$now2  = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  cooldownEnd[R,AAA] = $cdEnd  (now=$now2, remaining=$([int64]$cdEnd - [int64]$now2)s)"

# Deposit 2 immediately (must revert CooldownActive)
$out = cast call --from $R $F "deposit(address,uint256)" $HOOK 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "2nd deposit during cooldown" $out

# Warp +30 min (still locked)
[void](cast rpc evm_increaseTime 1800 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  +30min: now=$now2, remaining=$([int64]$cdEnd - [int64]$now2)s"
$out = cast call --from $R $F "deposit(address,uint256)" $HOOK 1000000000000000000 --rpc-url $ANVIL 2>&1
Report "deposit at cooldown-30min (still locked)" $out

# Warp another 31 min to clear (total +61 min > 60)
[void](cast rpc evm_increaseTime 1860 --rpc-url $ANVIL)
[void](cast rpc evm_mine --rpc-url $ANVIL)
$now2 = ((cast block latest --rpc-url $ANVIL --field timestamp).Trim() -split " ")[0]
Write-Host "  +61min: now=$now2, past cooldownEnd by $([int64]$now2 - [int64]$cdEnd)s"
$out = cast send $F "deposit(address,uint256)" $HOOK 1000000000000000000 --rpc-url $ANVIL --private-key $R_KEY 2>&1
Report "deposit after cooldown lift" $out

# Restore cooldown=0
[void](cast send $F "setCooldownDuration(uint256)" 0 --rpc-url $ANVIL --private-key $DKEY)
Write-Host ""
Write-Host "============================================================"
Write-Host " BATCH A DONE"
Write-Host "============================================================"
