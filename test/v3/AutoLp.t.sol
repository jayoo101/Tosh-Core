// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshAutoLp} from "../../src/v3/ToshAutoLp.sol";
import {ToshToken} from "../../src/ToshToken.sol";

contract AutoLpTestV3 is V2BaseV3 {
    using PoolIdLibrary for PoolKey;

    uint8 constant NOTHING_PENDING = 1;
    uint8 constant NO_TWAP = 2;
    uint8 constant SPOT_ABOVE_TWAP = 3;

    event Deferred(address indexed hook, uint8 reason);

    ToshToken token;
    ToshLaunchpadHookV3 hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        _launchAsAdmin(hook);
        _nextBlock();
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _matureTwap() internal {
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
    }

    /// @dev Lift spot a few shelves and let the TWAP agree.
    function _openLadder() internal {
        _swapBuy(hook, trader, 0.1e18);
        _matureTwap();
    }

    function _liquidity() internal view returns (uint128) {
        return poolManager.getLiquidity(hook.getPoolKey().toId());
    }

    /// @dev Quote side of the pool's virtual reserve, as `ToshAutoLp` reads it.
    function _reserve() internal view returns (uint256) {
        (uint160 spot,,,) = poolManager.getSlot0(hook.getPoolKey().toId());
        return (uint256(_liquidity()) << 96) / spot;
    }

    /// @dev Hand `amount` to autoLp as the hook would. With `reason` != 0,
    ///      expect the deposit to defer for it.
    function _depositAsHook(uint256 amount, uint8 reason) internal {
        quote.mint(address(autoLp), amount);
        if (reason != 0) {
            vm.expectEmit(address(autoLp));
            emit Deferred(address(hook), reason);
        }
        vm.prank(address(hook));
        autoLp.deposit(amount);
    }

    function _mintShelves(address who) internal returns (uint256 cost) {
        uint256 amount = hook.tierSize();
        cost = lens.quoteMint(address(hook), amount);
        vm.prank(who, who);
        hook.mintBondingCurve(amount, cost);
    }

    function _assertBooksMatchBalances() internal view {
        assertEq(quote.balanceOf(address(autoLp)), autoLp.pendingQuote(address(hook)), "quote held == pending");
        assertEq(token.balanceOf(address(autoLp)), autoLp.pendingToken(address(hook)), "tokens held == pending");
    }

    // ─── wiring ───────────────────────────────────────────────────────────────

    function test_wiring() public view {
        assertEq(hook.autoLp(), address(autoLp));
        assertEq(autoLp.factory(), address(factory));
        assertEq(hook.LP_SHARE_BPS() + hook.PLATFORM_TAX_BPS(), 8_100, "80 % + 1 %, 19 % to the project");
    }

    function test_revert_setFactory_twice() public {
        vm.prank(admin);
        vm.expectRevert(ToshAutoLp.FactoryAlreadySet.selector);
        autoLp.setFactory(address(factory));
    }

    function test_revert_setFactory_notDeployer() public {
        vm.prank(admin);
        ToshAutoLp fresh = new ToshAutoLp(address(vault), address(poolManager));
        vm.expectRevert(ToshAutoLp.OnlyDeployer.selector);
        fresh.setFactory(address(factory));
    }

    function test_revert_setFactory_otherAutoLp() public {
        vm.prank(admin);
        ToshAutoLp fresh = new ToshAutoLp(address(vault), address(poolManager));
        vm.prank(admin);
        vm.expectRevert(ToshAutoLp.FactoryMismatch.selector);
        fresh.setFactory(address(factory));
    }

    function test_revert_deposit_unknownHook() public {
        vm.prank(trader);
        vm.expectRevert(ToshAutoLp.UnknownHook.selector);
        autoLp.deposit(1);
    }

    function test_revert_lockAcquired_notVault() public {
        vm.expectRevert(ToshAutoLp.OnlyVault.selector);
        autoLp.lockAcquired("");
    }

    // ─── the add ──────────────────────────────────────────────────────────────

    function test_shelfMint_buysAndLocksLiquidity() public {
        _openLadder();
        uint128 l0 = _liquidity();
        uint256 tokensInPool0 = token.balanceOf(address(vault));
        uint256 cost = _mintShelves(bob);
        uint256 lpCut = cost * hook.LP_SHARE_BPS() / 10_000;

        assertGt(_liquidity(), l0, "pool deepened");
        assertGt(autoLp.totalTokenAdded(address(hook)), 0, "bought tokens went in");
        // What it bought went straight back in, so the token side is flat.
        assertApproxEqAbs(token.balanceOf(address(vault)), tokensInPool0, 1e6, "bought tokens re-added");
        assertEq(autoLp.pendingQuote(address(hook)) + autoLp.totalQuoteAdded(address(hook)), lpCut);
        assertLt(autoLp.pendingQuote(address(hook)), lpCut / 100, "almost all of it went in");
        _assertBooksMatchBalances();
    }

    function test_shelfMint_autoLpBuyIsTaxed() public {
        _openLadder();
        uint256 resBefore = ladder.reservoir();
        uint256 cost = _mintShelves(bob);
        assertGt(
            ladder.reservoir() - resBefore, cost / 100, "the reservoir's 40 bps of autoLp's buy, on top of the 1 %"
        );
    }

    function test_shelfMint_autoLpBuyCarriesNoPiggyback() public {
        _openLadder();
        vm.prank(admin);
        ladder.addLadderToken(address(token));
        quote.mint(address(ladder), 10e18);
        uint256 resBefore = ladder.reservoir();
        uint256 cost = _mintShelves(bob);
        assertGe(ladder.reservoir(), resBefore + cost / 100, "no buyback spent the reservoir");
    }

    function test_shelfMint_locksTheRestOfTheBlock() public {
        _openLadder();
        _mintShelves(bob);
        uint256 amount = hook.tierSize();
        vm.prank(carol, carol);
        vm.expectRevert(ToshLaunchpadHookV3.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(amount, type(uint256).max);
    }

    // ─── deferral ─────────────────────────────────────────────────────────────

    function test_deposit_beforeTwap_deferred() public {
        assertEq(hook.twapSqrtPriceX96(), 0);
        uint128 l0 = _liquidity();
        _depositAsHook(1e18, NO_TWAP);
        assertEq(autoLp.pendingQuote(address(hook)), 1e18);
        assertEq(_liquidity(), l0);
        _assertBooksMatchBalances();
    }

    function test_deposit_spotAboveTwap_deferredThenFlushed() public {
        _matureTwap();
        _swapBuy(hook, trader, 1e18); // ~10 % of the pool's quote
        _depositAsHook(0.05e18, SPOT_ABOVE_TWAP);
        assertEq(autoLp.pendingQuote(address(hook)), 0.05e18);

        // The TWAP catches up after a quiet window; then anyone can flush.
        _matureTwap();
        autoLp.flush(address(hook));
        assertLt(autoLp.pendingQuote(address(hook)), 0.0005e18);
        _assertBooksMatchBalances();
    }

    function test_deposit_cappedPerRun_restPending() public {
        _openLadder();
        uint256 cap = _reserve() * autoLp.MAX_DEPTH_BPS() / 10_000;
        _depositAsHook(cap * 3, 0);
        uint256 added = autoLp.totalQuoteAdded(address(hook));
        assertLe(added, cap, "one run commits at most the cap");
        assertGt(added, cap * 99 / 100);
        assertGe(autoLp.pendingQuote(address(hook)), cap * 2);
        _assertBooksMatchBalances();

        _matureTwap();
        autoLp.flush(address(hook));
        assertGt(autoLp.totalQuoteAdded(address(hook)), added + cap * 99 / 100, "flush runs one more capped add");
        _assertBooksMatchBalances();
    }

    function test_revert_flush_sameBlockAsSwap() public {
        _openLadder();
        _depositAsHook(10e18, 0);
        _swapBuy(hook, trader, 0.01e18);
        vm.expectRevert(ToshAutoLp.PriceMovedThisBlock.selector);
        autoLp.flush(address(hook));
    }

    function test_revert_flush_nothingPending() public {
        _openLadder();
        vm.expectRevert(abi.encodeWithSelector(ToshAutoLp.NothingAdded.selector, NOTHING_PENDING));
        autoLp.flush(address(hook));
    }

    function test_revert_flush_unknownHook() public {
        vm.expectRevert(ToshAutoLp.UnknownHook.selector);
        autoLp.flush(trader);
    }

    // ─── over many sales ──────────────────────────────────────────────────────

    function test_manyShelfMints_booksStayExact() public {
        _openLadder();
        address[3] memory buyers = [bob, carol, alice];
        uint256 lpTotal;
        for (uint256 i; i < 12; ++i) {
            if (hook.maxMintable() == 0) {
                _swapBuy(hook, trader, 0.2e18);
                _matureTwap();
                continue;
            }
            lpTotal += _mintShelves(buyers[i % 3]) * hook.LP_SHARE_BPS() / 10_000;
            _nextBlock();
        }
        assertGt(lpTotal, 0);
        // Fees the position earned are settled into later adds, so the books
        // can only exceed what was deposited.
        assertGe(autoLp.pendingQuote(address(hook)) + autoLp.totalQuoteAdded(address(hook)), lpTotal);
        _assertBooksMatchBalances();
    }
}
