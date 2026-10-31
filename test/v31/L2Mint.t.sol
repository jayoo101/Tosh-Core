// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {wadExp} from "solmate/src/utils/SignedWadMath.sol";

import {V31Base} from "./utils/V31Base.sol";
import {ToshLaunchpadHookV31} from "../../src/v31/ToshLaunchpadHookV31.sol";
import {ToshFactoryV31} from "../../src/v31/ToshFactoryV31.sol";
import {ToshTokenV31} from "../../src/v31/ToshTokenV31.sol";
import {ToshMintVesting} from "../../src/v31/ToshMintVesting.sol";
import {ToshHookLensV31} from "../../src/v31/ToshHookLensV31.sol";

contract L2MintTestV31 is V31Base {
    ToshTokenV31 internal token;
    ToshLaunchpadHookV31 internal hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _launched();
    }

    function _mint(address who, uint256 pay) internal returns (uint256 tokens, uint256 cost) {
        vm.prank(who);
        return hook.mintL2(pay, 0);
    }

    // ─── Launch ───────────────────────────────────────────────────────────────

    function test_launch_opensCurveAtP0() public view {
        assertEq(hook.l2Supply(), 730_000_000e18, "sold-out raise sells the full L2 supply");
        assertEq(hook.l2Price(), hook.p0(), "curve opens at the pool price");
        (uint256 minted, uint256 lastMintAt, uint256 lastPrice) = hook.l2State();
        assertEq(minted, 0);
        assertEq(lastMintAt, block.timestamp);
        assertEq(lastPrice, hook.p0());
        assertEq(hook.l2Quota(), HARD_CAP / 10, "quota is 10% of the raise");
    }

    function test_launch_partialRaiseScalesSupply() public {
        (, ToshLaunchpadHookV31 h) = _create("Beta", 2_000e18);
        vm.prank(alice, alice);
        h.buyGenesis(AGENT_CAP, 0);
        vm.warp(h.genesisDeadline());
        _launch(h);
        assertEq(h.l2Supply(), 730_000_000e18 * h.raised() / 2_000e18);
        assertEq(h.l2Quota(), MIN_BUY, "quota never falls below minBuy");
    }

    function test_mint_revertsBeforeLaunch() public {
        (, ToshLaunchpadHookV31 h) = _create("Gamma", HARD_CAP);
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHookV31.NotLaunched.selector);
        h.mintL2(MIN_BUY, 0);
    }

    // ─── Mint ─────────────────────────────────────────────────────────────────

    function test_mint_locksTokensAndSplitsPayment() public {
        uint256 pay = 100e18;
        uint256 ladderBefore = quote.balanceOf(address(ladder));
        uint256 vaultBefore = quote.balanceOf(hook.projectAdmin());
        uint256 aliceBefore = quote.balanceOf(alice);

        (uint256 tokens, uint256 cost) = _mint(alice, pay);

        assertEq(cost, pay);
        assertEq(aliceBefore - quote.balanceOf(alice), pay);
        assertEq(quote.balanceOf(address(ladder)) - ladderBefore, pay / 100, "1% buyback");
        assertEq(quote.balanceOf(hook.projectAdmin()) - vaultBefore, pay * 19 / 100, "19% project");
        assertEq(token.balanceOf(alice), 0, "nothing delivered up front");
        assertEq(token.balanceOf(address(vesting)), tokens, "all of it vests");
        (uint256 total,,,) = vesting.lockOf(address(hook), alice);
        assertEq(total, tokens);
    }

    function test_mint_paysBetweenStartAndEndPrice() public {
        uint256 p = hook.l2Price();
        (uint256 tokens, uint256 cost) = _mint(alice, 100e18);
        (,, uint256 pAfter) = hook.l2State();
        assertGt(pAfter, p);
        // Average price paid lies strictly between the start and end price.
        assertLt(tokens * p, cost * 1e18);
        assertGt(tokens * pAfter, cost * 1e18);
        // p' = p + kC, k = ln(247) / supply.
        assertEq(pAfter, p + hook.LN_SPAN_WAD() * 100e18 / hook.l2Supply());
    }

    function test_mint_followsClosedFormCurveWithoutDecay() public {
        uint256 p0 = hook.p0();
        for (uint256 i; i < 10; ++i) {
            _mint(_agent(hook, i), 100e18);
        }
        (uint256 minted,, uint256 price) = hook.l2State();
        uint256 expected = p0 * uint256(wadExp(int256(hook.LN_SPAN_WAD() * minted / hook.l2Supply()))) / 1e18;
        assertApproxEqRel(price, expected, 1e6, "price = p0 * 247^(x/S)");
    }

    function test_mint_splittingDoesNotChangeTheCurve() public {
        // Two mints of C land where one mint of 2C would.
        uint256 snap = vm.snapshotState();
        (uint256 one,) = _mint(_agent(hook, 1), 100e18);
        (uint256 two,) = _mint(_agent(hook, 2), 100e18);
        (,, uint256 priceSplit) = hook.l2State();
        vm.revertToState(snap);

        // 200e18 exceeds the 100e18 quota, so compare through the lens instead.
        (uint256 whole,, uint256 priceWhole) = lens.quoteL2(address(hook), 200e18);
        assertApproxEqRel(one + two, whole, 1e9, "wadLn rounding only");
        assertApproxEqAbs(priceSplit, priceWhole, 2, "one floor per mint");
    }

    function test_mint_minTokensProtects() public {
        (uint256 q,,) = lens.quoteL2(address(hook), 50e18);
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHookV31.BelowMinTokens.selector);
        hook.mintL2(50e18, q + 1);
        vm.prank(alice);
        (uint256 tokens,) = hook.mintL2(50e18, q);
        assertEq(tokens, q, "lens quote is exact");
    }

    function test_mint_belowMinBuyReverts() public {
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHookV31.BelowMinBuy.selector);
        hook.mintL2(MIN_BUY - 1, 0);
    }

    function test_mint_aboveQuotaReverts() public {
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHookV31.AboveL2Quota.selector);
        hook.mintL2(HARD_CAP / 10 + 1, 0);
    }

    function test_mint_aboveFactoryCapReverts() public {
        vm.prank(admin);
        factory.setShelfCapPerAgent(50e18);
        vm.prank(alice);
        vm.expectRevert(ToshFactoryV31.ShelfCapExceeded.selector);
        hook.mintL2(60e18, 0);
    }

    function test_mint_requiresAgentId() public {
        vm.prank(dave);
        vm.expectRevert(ToshFactoryV31.NoAgentId.selector);
        hook.mintL2(MIN_BUY, 0);
    }

    function test_mint_oncePerWallet() public {
        _mint(alice, MIN_BUY);
        vm.prank(alice);
        vm.expectRevert(ToshFactoryV31.AlreadyMinted.selector);
        hook.mintL2(MIN_BUY, 0);

        // A fresh Agent ID on the same wallet does not reopen it.
        registry.setHandle(alice, "alice-2");
        vm.prank(alice);
        vm.expectRevert(ToshFactoryV31.AlreadyMinted.selector);
        hook.mintL2(MIN_BUY, 0);
    }

    function test_mint_oncePerAgentId() public {
        _mint(alice, MIN_BUY);
        address fresh = makeAddr("fresh");
        quote.mint(fresh, 1_000e18);
        vm.prank(fresh);
        quote.approve(address(hook), type(uint256).max);
        registry.setHandle(fresh, "alice");
        vm.prank(fresh);
        vm.expectRevert(ToshFactoryV31.AlreadyMinted.selector);
        hook.mintL2(MIN_BUY, 0);
    }

    function test_mint_separateFromGenesisAllowance() public {
        // alice never bought genesis on this project; a genesis buyer can mint too.
        address genesisBuyer = vm.addr(0xA000);
        quote.mint(genesisBuyer, 1_000e18);
        vm.prank(genesisBuyer);
        quote.approve(address(hook), type(uint256).max);
        vm.prank(genesisBuyer);
        hook.mintL2(MIN_BUY, 0);
        assertEq(factory.shelfRemaining(address(hook), genesisBuyer), 0);
        assertEq(factory.shelfRemaining(address(hook), alice), SHELF_CAP);
    }

    function test_mint_haltedReverts() public {
        vm.prank(admin);
        factory.haltLadderMinting(address(hook), 1 hours);
        vm.prank(alice);
        vm.expectRevert(ToshFactoryV31.LadderHalted.selector);
        hook.mintL2(MIN_BUY, 0);
    }

    // ─── Dutch decay ──────────────────────────────────────────────────────────

    function test_decay_countsWholeMinutesOnly() public {
        _mint(alice, 50e18);
        (, uint256 t0, uint256 p) = hook.l2State();

        vm.warp(t0 + 59);
        assertEq(hook.l2Price(), p, "no step before a full minute");
        vm.warp(t0 + 60);
        assertEq(hook.l2Price(), p * 999 / 1000, "-0.1% after one minute");

        vm.warp(t0 + 10 minutes + 30);
        uint256 expected = p;
        for (uint256 i; i < 10; ++i) {
            expected = expected * 999 / 1000;
        }
        assertApproxEqAbs(hook.l2Price(), expected, 10, "0.999^10 after ten minutes");
    }

    function _pow999(uint256 p, uint256 n) internal pure returns (uint256) {
        for (uint256 i; i < n; ++i) {
            p = p * 999 / 1000;
        }
        return p;
    }

    function test_decay_stopsWhileHalted() public {
        _mint(alice, 50e18);
        (, uint256 t0, uint256 p) = hook.l2State();

        vm.warp(t0 + 10 minutes);
        vm.prank(admin);
        factory.haltLadderMinting(address(hook), 1 hours);
        uint256 atHalt = hook.l2Price();
        assertApproxEqAbs(atHalt, _pow999(p, 10), 10);

        vm.warp(t0 + 10 minutes + 1 hours);
        assertEq(hook.l2Price(), atHalt, "frozen for the whole halt");

        vm.warp(t0 + 15 minutes + 1 hours);
        assertApproxEqAbs(hook.l2Price(), _pow999(p, 15), 10, "resumes where it stopped");
    }

    function test_decay_resumeEarlyAndGlobalHaltBothCount() public {
        _mint(alice, 50e18);
        (, uint256 t0, uint256 p) = hook.l2State();

        vm.warp(t0 + 2 minutes);
        vm.prank(admin);
        factory.haltLadderMinting(address(hook), 7 days);
        vm.warp(t0 + 32 minutes);
        vm.prank(admin);
        factory.resumeLadderMinting(address(hook));

        vm.warp(t0 + 35 minutes);
        vm.prank(admin);
        factory.haltLadderMinting(address(0), 2 hours);
        vm.warp(t0 + 35 minutes + 3 hours);

        // 2 + 3 unhalted minutes before the global halt, 1 hour after it lapsed.
        assertApproxEqRel(hook.l2Price(), _pow999(p, 65), 1e9);
        assertEq(factory.ladderHaltedSeconds(address(hook)), 30 minutes + 2 hours);
    }

    function test_decay_haltClockOnlyMovesForward() public {
        vm.startPrank(admin);
        factory.haltLadderMinting(address(hook), 1 hours);
        vm.warp(block.timestamp + 20 minutes);
        factory.haltLadderMinting(address(hook), 1 hours); // re-armed mid-halt
        vm.warp(block.timestamp + 2 hours);
        vm.stopPrank();
        assertEq(factory.ladderHaltedSeconds(address(hook)), 20 minutes + 1 hours);
        assertEq(factory.ladderHaltedSeconds(address(0xBEEF)), 0, "a halt on one hook is not another's");
        assertFalse(factory.ladderMintingHalted(address(hook)));
    }

    function test_decay_isPermanent() public {
        _mint(alice, 50e18);
        vm.warp(block.timestamp + 2 hours);
        uint256 decayed = hook.l2Price();
        (,, uint256 lastPrice) = hook.l2State();
        assertLt(decayed, lastPrice);

        _mint(bob, 20e18);
        (,, uint256 afterMint) = hook.l2State();
        assertEq(afterMint, decayed + hook.LN_SPAN_WAD() * 20e18 / hook.l2Supply(), "next mint starts from the decay");
    }

    function test_decay_hasNoFloor_sweepsRemainderAndChargesOnlyCost() public {
        vm.warp(block.timestamp + 30 days);
        assertEq(hook.l2Price(), 1, "no floor");

        uint256 before = quote.balanceOf(alice);
        (uint256 tokens, uint256 cost) = _mint(alice, MIN_BUY);
        assertEq(tokens, hook.l2Supply(), "remainder minted");
        assertLt(cost, MIN_BUY, "only the remainder's cost is charged");
        assertEq(before - quote.balanceOf(alice), cost);

        assertLe(token.totalSupply(), token.MAX_SUPPLY());
        assertApproxEqRel(token.totalSupply(), token.MAX_SUPPLY(), 1e6, "genesis + L2 lands on 1B");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHookV31.L2SoldOut.selector);
        hook.mintL2(MIN_BUY, 0);
    }

    function test_lens_stateAndAccount() public {
        ToshHookLensV31.L2State memory s = lens.l2State(address(hook));
        assertTrue(s.launched);
        assertEq(s.price, hook.p0());
        assertEq(s.supply, hook.l2Supply());
        assertEq(s.quota, HARD_CAP / 10);

        ToshHookLensV31.L2Account memory a = lens.l2Account(address(hook), alice);
        assertEq(a.mintable, HARD_CAP / 10, "min(factory cap, quota)");
        (uint256 tokens,) = _mint(alice, MIN_BUY);
        a = lens.l2Account(address(hook), alice);
        assertEq(a.mintable, 0);
        assertEq(a.lockedTotal, tokens);
    }

    // ─── Vesting ──────────────────────────────────────────────────────────────

    function test_vesting_unlocksLinearlyPerMinuteOver12h() public {
        (uint256 tokens,) = _mint(alice, 100e18);
        (,, uint256 t0,) = vesting.lockOf(address(hook), alice);

        vm.prank(alice);
        vm.expectRevert(ToshMintVesting.NothingToClaim.selector);
        vesting.claim(address(hook));

        vm.warp(t0 + 59);
        (,,, uint256 claimable) = vesting.lockOf(address(hook), alice);
        assertEq(claimable, 0, "nothing before the first minute");

        vm.warp(t0 + 60);
        vm.prank(alice);
        uint256 first = vesting.claim(address(hook));
        assertEq(first, tokens / 720, "1/720 per minute");

        vm.warp(t0 + 6 hours);
        vm.prank(alice);
        vesting.claim(address(hook));
        assertEq(token.balanceOf(alice), tokens / 2, "half at 6h");

        vm.warp(t0 + 12 hours + 1 days);
        vm.prank(alice);
        vesting.claim(address(hook));
        assertEq(token.balanceOf(alice), tokens, "all at 12h");
        assertEq(token.balanceOf(address(vesting)), 0);

        vm.prank(alice);
        vm.expectRevert(ToshMintVesting.NothingToClaim.selector);
        vesting.claim(address(hook));
    }

    function test_vesting_onlyRegisteredHooksLock() public {
        vm.expectRevert(ToshMintVesting.UnknownHook.selector);
        vesting.lock(alice, 1e18);
    }

    function test_vesting_factoryBindsOnce() public {
        vm.prank(admin);
        vm.expectRevert(ToshMintVesting.FactoryAlreadySet.selector);
        vesting.setFactory(address(factory));

        ToshMintVesting other = new ToshMintVesting();
        vm.expectRevert(ToshMintVesting.FactoryMismatch.selector);
        other.setFactory(address(factory));
    }

    // ─── Pool ─────────────────────────────────────────────────────────────────

    function test_pool_tradesAfterMints() public {
        _mint(alice, 100e18);
        _mint(bob, 100e18);
        uint256 before = token.balanceOf(trader);
        _swapBuy(hook, trader, 10e18);
        assertGt(token.balanceOf(trader), before);
        _swapSell(hook, trader, token.balanceOf(trader) / 2);
    }
}
