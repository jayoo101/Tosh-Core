// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {ICLHooks} from "infinity-core/src/pool-cl/interfaces/ICLHooks.sol";
import {Hooks} from "infinity-core/src/libraries/Hooks.sol";
import {CustomRevert} from "infinity-core/src/libraries/CustomRevert.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {CircuitRevenueVault} from "../../src/CircuitRevenueVault.sol";

/// @notice Adversarial PoCs against ToshLaunchpadHookV3 (v2).
/// @dev    `test_DESIGN_*` pin accepted behaviour: the Circuit holder funds the
///         project through shelves at ~1 % net cost once the market has risen
///         to them, which is the point of routing 99 % of proceeds to it.
///         `test_OPEN_*` pin behaviour that is known and not yet changed: they
///         pass while the issue stands, and are meant to fail, and be inverted,
///         by whatever change closes it.
contract HookAuditTestV3 is V2BaseV3 {
    using PoolIdLibrary for PoolKey;

    ToshToken token;
    ToshLaunchpadHookV3 hook;

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
    // H-1 (accepted by design): the shelf beneficiary mints at ~1 % net cost.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev With a par ceiling nothing is mintable until the market has risen
    ///      to a shelf's price, so there is no band to dump at the open.
    function test_H1_noShelfOpensAtLaunch() public {
        _launched();
        assertEq(hook.maxMintable(), 0, "a flat market opens no shelf");
        vm.prank(dev, dev);
        vm.expectRevert(ToshLaunchpadHookV3.TierPriceAboveCeiling.selector);
        hook.mintBondingCurve(1e18, type(uint256).max);
    }

    /// @dev No outside buyers at all: the controller funds its own pump, waits
    ///      one TWAP window, mints the unlocked shelves, then dumps everything.
    function test_DESIGN_H1_controllerSelfFundedCycles_drainGenesisLp() public {
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
                uint256 cost = lens.quoteMint(address(hook), m);
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
    ///      raise. At a 105 % ceiling a 0.5 % raise lost 85 % of its pool quote
    ///      in the block after launch; at par the thin pool opens nothing.
    function test_H1_thinRaise_noShelfOpensAtLaunch() public {
        (, ToshLaunchpadHookV3 h2) = _create("Thin", HARD_CAP, AGENT_CAP);
        _buy(h2, carol, 0.5e18);
        _launchAsAdmin(h2);
        _nextBlock();
        assertEq(h2.maxMintable(), 0);
    }

    /// @dev The pool's token side is 2.8 M × raised / hardCap, so shelves shrink
    ///      by the same ratio and each stays the same share of the pool.
    function test_H1_shelvesScaleWithTheRaise() public {
        (, ToshLaunchpadHookV3 thin) = _create("Thin", HARD_CAP, AGENT_CAP);
        _buy(thin, carol, 0.5e18);
        _sellOut(hook);
        assertEq(thin.tierSize(), 0, "unset before launch");

        _launchAsAdmin(hook);
        _launchAsAdmin(thin);
        uint256 raised = thin.raised();
        assertEq(thin.tierSize(), Math.mulDiv(thin.TIER_SIZE(), raised, HARD_CAP, Math.Rounding.Ceil));
        assertLt(thin.tierSize(), thin.TIER_SIZE() / 100, "a 0.5 % raise sells 0.5 % shelves");
        assertEq(hook.tierSize(), hook.TIER_SIZE(), "a sold-out raise sells full shelves");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-1: a tax-free 99-wei swap used to shut shelf minting for the block.
    // ─────────────────────────────────────────────────────────────────────────

    function test_L1_dustSwapNoLongerGriefsShelfMint() public {
        _launched();
        _swapBuy(hook, trader, 0.1e18); // the market rises to shelf 0
        _nextBlock();
        assertGt(hook.maxMintable(), 0, "shelves open");
        uint256 amount = hook.tierSize() / 2;
        uint256 cost = lens.quoteMint(address(hook), amount);

        _swapBuy(hook, trader, 99); // front-run by griefer
        assertGt(hook.maxMintable(), 0, "a dust swap leaves the ladder open");

        vm.prank(bob, bob);
        hook.mintBondingCurve(amount, cost);
    }

    function test_L1_aSwapThatMovesThePriceStillShutsTheBlock() public {
        _launched();
        _swapBuy(hook, trader, 99);
        _swapBuy(hook, trader, 0.1e18);
        assertEq(hook.maxMintable(), 0);
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1e18, type(uint256).max);
    }

    function test_L1_launchBlockStaysShut() public {
        _launchAsAdmin(hook);
        assertEq(hook.maxMintable(), 0);
        _swapBuy(hook, trader, 99);
        assertEq(hook.maxMintable(), 0, "a swap in the launch block does not open it");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // L-2: range orders let a holder exit (or a buyer enter) with zero hook tax.
    // ─────────────────────────────────────────────────────────────────────────

    function test_L2_rangeOrderIsRefused() public {
        _launched();
        PoolKey memory key = hook.getPoolKey();
        int24 t = _tick();
        int24 upper = (t / 200) * 200;
        if (t < 0 && t % 200 != 0) upper -= 200;
        if (upper == t) upper -= 200;
        int24 lower = upper - 2000;

        vm.startPrank(alice);
        token.approve(address(router), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                ICLHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(ToshLaunchpadHookV3.RangeNotFull.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: 1e18, salt: bytes32("alice-ro")
            }),
            ""
        );
        vm.stopPrank();
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
        vm.expectRevert(ToshLaunchpadHookV3.AgentCapReached.selector);
        hook.buyGenesis(1e18, 0);

        registry.setHandle(alice, "alice-second-name");
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHookV3.AgentCapReached.selector);
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
        assertEq(hook.maxMintable(), hook.MAX_TIERS_PER_TX() * hook.tierSize(), "full 32-shelf run open");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Info: controller pointing projectFund at the hook leaks the fund.
    // ─────────────────────────────────────────────────────────────────────────

    function test_I2_projectFundCannotBeTheHook() public {
        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHookV3.ZeroAddress.selector);
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
        ReenterV3 code = new ReenterV3();
        vm.etch(w, address(code).code);
        registry.setHandle(w, "reenter");
        vm.deal(w, 10 ether);
        vm.prank(w, w);
        vm.expectRevert(ToshLaunchpadHookV3.NativeTransferFailed.selector);
        hook.buyGenesis{value: 6e18}(6e18, 0);
    }
}

contract ReenterV3 {
    receive() external payable {
        ToshLaunchpadHookV3(payable(msg.sender)).buyGenesis{value: 0}(1e18, 0);
    }
}
