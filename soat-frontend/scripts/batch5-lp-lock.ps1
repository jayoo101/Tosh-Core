$ANVIL = "http://127.0.0.1:8545"
$POOL_MGR = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408"
$FFF = (Get-Content -Path "$PSScriptRoot\..\..\.fork-fff.json" -Raw | ConvertFrom-Json).fff_hook

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

Write-Host "------------------------------------------------------------"
Write-Host "I9 / LP PERMANENT LOCK via beforeRemoveLiquidity"
Write-Host "    Impersonate PoolManager → directly invoke hook.beforeRemoveLiquidity"
Write-Host "    Must revert RemoveLiquidityForbidden (0x41dce6b6)"
Write-Host "------------------------------------------------------------"
Write-Host "  FFF hook = $FFF"
[void](cast rpc anvil_impersonateAccount $POOL_MGR --rpc-url $ANVIL)
[void](cast rpc anvil_setBalance $POOL_MGR 0xde0b6b3a7640000 --rpc-url $ANVIL)

# Construct dummy params: address (zero), PoolKey (5 fields), ModifyLiquidityParams (3 fields), bytes
# PoolKey: (currency0, currency1, fee, tickSpacing, hooks)
# ModifyLiquidityParams: (tickLower, tickUpper, liquidityDelta, salt)
# We pass tickLower=-887220, tickUpper=887220, liquidityDelta=-1 (negative = remove), salt=0x0

# Use cast send via impersonated PoolManager
$caller = "0x0000000000000000000000000000000000000000"
$dummyKey = "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
# We can't easily build PoolKey calldata via cast args.  Use cast call to skip mining:
$out = cast send --from $POOL_MGR --unlocked $FFF "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)" 0x0000000000000000000000000000000000000000 "(0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,3000,60,$FFF)" "(-887220,887220,-1,0x0000000000000000000000000000000000000000000000000000000000000000)" 0x --rpc-url $ANVIL 2>&1
Report "PoolManager calls beforeRemoveLiquidity" $out

Write-Host ""
Write-Host "  Bonus: test from NON-PoolManager (should revert onlyPoolManager guard)"
$out = cast call $FFF "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)" 0x0000000000000000000000000000000000000000 "(0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,3000,60,$FFF)" "(-887220,887220,-1,0x0000000000000000000000000000000000000000000000000000000000000000)" 0x --rpc-url $ANVIL 2>&1
Report "random caller (not PoolManager)" $out

[void](cast rpc anvil_stopImpersonatingAccount $POOL_MGR --rpc-url $ANVIL)
