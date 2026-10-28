// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshHookLensV3} from "../../src/v3/ToshHookLensV3.sol";
import {CircuitNFT} from "../../src/CircuitNFT.sol";
import {CircuitRevenueVault} from "../../src/CircuitRevenueVault.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";

/// @notice Everything after `launch()`: the swap tax, the buyback reservoir,
///         the TWAP, the shelf ladder's price gate and the Circuit vault.
contract PostLaunchTestV3 is V2BaseV3 {
    using PoolIdLibrary for PoolKey;

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

    function _swapExactOut(ToshLaunchpadHookV3 h, address who, bool buy, uint256 out) internal {
        PoolKey memory key = h.getPoolKey();
        vm.startPrank(who);
        IERC20(address(h.projectToken())).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: buy,
                amountSpecified: int256(out),
                sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
        vm.stopPrank();
    }

    /// @dev Let the pool sit untraded for a full window so the TWAP reads.
    function _matureTwap() internal {
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
    }

    /// @dev The ceiling is par, so nothing mints until the market has risen.
    ///      A buy of this size lifts spot ~2.5 %, about a dozen shelves, and a
    ///      quiet window makes the TWAP agree.
    function _openLadder() internal {
        _swapBuy(hook, trader, 0.1e18);
        _matureTwap();
    }

    function _list(ToshToken t) internal {
        vm.prank(admin);
        ladder.addLadderToken(address(t));
    }

    function _setReservoir(uint256 amount) internal {
        uint256 bal = quote.balanceOf(address(ladder));
        if (bal > amount) quote.burn(address(ladder), bal - amount);
        else quote.mint(address(ladder), amount - bal);
    }

    // ─── swap tax ─────────────────────────────────────────────────────────────

    function test_buyTax_exactInput_splitsSevenToThree() public {
        uint256 input = 1e18;
        uint256 resBefore = ladder.reservoir();
        uint256 platBefore = quote.balanceOf(platform);
        _swapBuy(hook, trader, input);
        uint256 tax = input * hook.TAX_BPS() / 10_000;
        uint256 platformCut = input * hook.PLATFORM_SWAP_FEE_BPS() / 10_000;
        assertEq(quote.balanceOf(platform) - platBefore, platformCut, "0.3 % to the platform");
        assertEq(ladder.reservoir() - resBefore, tax - platformCut, "0.7 % to the reservoir");
    }

    function test_sellTax_exactInput_burnsOnePercent() public {
        uint256 sell = 1_000e18;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 platBefore = quote.balanceOf(platform);
        _swapSell(hook, alice, sell);
        assertEq(token.balanceOf(DEAD) - deadBefore, sell / 100, "1 % of the token input burned");
        assertEq(quote.balanceOf(platform), platBefore, "the platform takes no share of a sell");
    }

    function test_buyTax_exactOutput_chargesTheInputNotTheOutput() public {
        uint256 resBefore = ladder.reservoir();
        uint256 platBefore = quote.balanceOf(platform);
        uint256 qBefore = quote.balanceOf(trader);
        uint256 deadBefore = token.balanceOf(DEAD);
        _swapExactOut(hook, trader, true, 10_000e18);
        assertEq(token.balanceOf(trader), 10_000e18, "exact output delivered");
        uint256 paid = qBefore - quote.balanceOf(trader);
        uint256 taxed = (ladder.reservoir() - resBefore) + (quote.balanceOf(platform) - platBefore);
        assertGt(taxed, 0, "input taxed");
        assertApproxEqRel(taxed, (paid - taxed) / 100, 1e15, "1 % of the pool input");
        assertEq(token.balanceOf(DEAD), deadBefore, "no tokens burned on a buy");
    }

    function test_sellTax_exactOutput_burnsTokenInput() public {
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 tBefore = token.balanceOf(alice);
        uint256 resBefore = ladder.reservoir();
        _swapExactOut(hook, alice, false, 0.1e18);
        uint256 spent = tBefore - token.balanceOf(alice);
        uint256 burned = token.balanceOf(DEAD) - deadBefore;
        assertGt(burned, 0);
        assertApproxEqRel(burned, (spent - burned) / 100, 1e15, "1 % of the token input");
        assertEq(ladder.reservoir(), resBefore, "a sell does not feed the reservoir");
    }

    function test_dustSwap_noTax() public {
        uint256 resBefore = ladder.reservoir();
        _swapBuy(hook, trader, 99);
        assertEq(ladder.reservoir(), resBefore);
    }

    // ─── TWAP ─────────────────────────────────────────────────────────────────

    function test_twap_zeroUntilAFullWindow() public {
        assertEq(hook.twapSqrtPriceX96(), 0, "launch block");
        vm.warp(block.timestamp + hook.TWAP_WINDOW() - 1);
        _swapBuy(hook, trader, 0.1e18);
        assertEq(hook.twapSqrtPriceX96(), 0, "one second short");
        vm.warp(block.timestamp + 1);
        assertGt(hook.twapSqrtPriceX96(), 0, "full window");
    }

    function test_twap_quietPoolReadsTheLastPrice() public {
        _swapBuy(hook, trader, 1e18);
        (uint160 spotSqrt,,,) = poolManager.getSlot0(_id(hook));
        _matureTwap();
        uint160 twap = hook.twapSqrtPriceX96();
        assertApproxEqRel(uint256(twap), uint256(spotSqrt), 1e16, "flat for a window = last tick");
    }

    function test_twap_resistsASameBlockPump() public {
        _matureTwap();
        uint160 before = hook.twapSqrtPriceX96();
        _swapBuy(hook, trader, 3e18);
        assertEq(hook.twapSqrtPriceX96(), before, "a swap now moves only future samples");
    }

    // ─── shelf gate ───────────────────────────────────────────────────────────

    function test_shelf_sameBlockAsASwapIsShut() public {
        _swapBuy(hook, trader, 0.1e18);
        assertEq(hook.maxMintable(), 0);
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1e18, type(uint256).max);
        _nextBlock();
        assertGt(hook.maxMintable(), 0);
    }

    function test_shelf_maxMintableIsExactlyTheGate() public {
        _openLadder();
        uint256 max = hook.maxMintable();
        assertGt(max, hook.tierSize(), "a risen market opens several shelves");
        (,,,,, uint256 ceiling,) = hook.tierStatus();
        uint256 shelves = max / hook.tierSize();
        assertLe(hook.tierPriceAt(shelves - 1), ceiling, "last open shelf under the ceiling");
        assertGt(hook.tierPriceAt(shelves), ceiling, "next shelf above it");

        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.TierPriceAboveCeiling.selector);
        hook.mintBondingCurve(max + 1, type(uint256).max);

        uint256 cost = lens.quoteMint(address(hook), max);
        uint256 before = quote.balanceOf(bob);
        vm.prank(bob, bob);
        uint256 charged = hook.mintBondingCurve(max, cost);
        assertEq(charged, cost, "quote is the charge");
        assertEq(before - quote.balanceOf(bob), cost);
        assertEq(hook.currentTierIndex(), shelves);
        assertEq(hook.phase2Minted(), max);
        assertEq(hook.maxMintable(), 0, "the rest waits for the market");
    }

    function test_shelf_paymentSplitsOneToTheReservoir() public {
        _openLadder();
        uint256 amount = hook.tierSize() * 3 / 2; // spans two shelves
        uint256 cost = lens.quoteMint(address(hook), amount);
        uint256 resBefore = ladder.reservoir();
        uint256 vaultBefore = quote.balanceOf(hook.projectAdmin());
        vm.prank(bob, bob);
        hook.mintBondingCurve(amount, cost);
        uint256 platformCut = cost * hook.PLATFORM_TAX_BPS() / 10_000;
        uint256 lpCut = cost * hook.LP_SHARE_BPS() / 10_000;
        // On top of the 1 %, the reservoir's share of the tax on autoLp's buy.
        uint256 resGain = ladder.reservoir() - resBefore;
        assertGe(resGain, platformCut);
        assertLt(resGain, platformCut + lpCut / 100);
        assertEq(quote.balanceOf(hook.projectAdmin()) - vaultBefore, cost - platformCut - lpCut);
        assertEq(
            autoLp.pendingQuote(address(hook)) + autoLp.totalQuoteAdded(address(hook)), lpCut, "80 % reached autoLp"
        );
        assertEq(hook.currentTierIndex(), 1);
        assertEq(hook.currentTierSold(), amount - hook.tierSize());
    }

    function test_revert_shelf_costAboveMax() public {
        _openLadder();
        uint256 cost = lens.quoteMint(address(hook), 1_000e18);
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.CostAboveMax.selector);
        hook.mintBondingCurve(1_000e18, cost - 1);
    }

    function test_revert_shelf_zero() public {
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.ZeroAmount.selector);
        hook.mintBondingCurve(0, 0);
        assertEq(lens.quoteMint(address(hook), 0), 0);
    }

    function test_shelf_pumpBeforeTheWindowCannotRaiseTheCeiling() public {
        uint256 before = hook.maxMintable();
        _swapBuy(hook, trader, 5e18);
        _nextBlock();
        assertEq(before, 0, "nothing at a flat open");
        assertLe(hook.maxMintable(), hook.tierSize(), "capped at p0, shelf 0, until the TWAP matures");
    }

    function test_shelf_dumpTightensTheGate() public {
        _openLadder();
        uint256 before = hook.maxMintable();
        _swapSell(hook, alice, token.balanceOf(alice));
        _nextBlock();
        assertLt(hook.maxMintable(), before);
    }

    function test_shelf_sustainedRiseOpensMoreShelves() public {
        uint256 before = hook.maxMintable();
        _swapBuy(hook, trader, 2e18);
        _matureTwap();
        assertGt(hook.maxMintable(), before, "a price held for a window lifts the ceiling");
    }

    function test_shelf_haltStopsMinting_resumeAndLapse() public {
        _openLadder();
        vm.prank(admin);
        factory.haltLadderMinting(address(hook), 1 days);
        assertTrue(factory.ladderMintingHalted(address(hook)));
        assertEq(hook.maxMintable(), 0);
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.LadderMintingHalted.selector);
        hook.mintBondingCurve(1e18, type(uint256).max);

        vm.prank(admin);
        factory.resumeLadderMinting(address(hook));
        assertFalse(factory.ladderMintingHalted(address(hook)));

        vm.prank(admin);
        factory.haltLadderMinting(address(0), 1 hours);
        assertTrue(factory.ladderMintingHalted(address(hook)), "global halt");
        vm.warp(block.timestamp + 1 hours);
        assertFalse(factory.ladderMintingHalted(address(hook)), "lapses on its own");

        vm.prank(admin);
        factory.haltLadderMinting(address(0), 1 hours);
        vm.prank(admin);
        factory.resumeLadderMinting(address(0));
        assertFalse(factory.ladderMintingHalted(address(hook)));
        _nextBlock();
        uint256 cost = lens.quoteMint(address(hook), 1e18);
        vm.prank(bob, bob);
        hook.mintBondingCurve(1e18, cost);
    }

    function test_revert_halt_durationBounds() public {
        uint256 maxHalt = factory.MAX_HALT_DURATION();
        vm.startPrank(admin);
        vm.expectRevert(ToshFactoryV3.HaltDurationTooLong.selector);
        factory.haltLadderMinting(address(hook), 0);
        vm.expectRevert(ToshFactoryV3.HaltDurationTooLong.selector);
        factory.haltLadderMinting(address(hook), maxHalt + 1);
        factory.haltLadderMinting(address(hook), maxHalt);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.haltLadderMinting(address(hook), 1 hours);
    }

    function test_lens_tiersAndRemaining() public {
        _openLadder();
        uint256 amount = hook.tierSize() + 100e18;
        uint256 cost = lens.quoteMint(address(hook), amount);
        vm.prank(bob, bob);
        hook.mintBondingCurve(amount, cost);

        ToshHookLensV3.Tier[] memory t = lens.getTiers(address(hook), 0, 3);
        assertEq(t.length, 3);
        assertEq(t[0].soldAmount, hook.tierSize());
        assertEq(t[1].soldAmount, 100e18);
        assertEq(t[2].soldAmount, 0);
        assertEq(t[1].price, hook.tierPriceAt(1));
        assertEq(lens.getTiers(address(hook), hook.TIER_COUNT(), 5).length, 0);
        assertEq(lens.getTiers(address(hook), hook.TIER_COUNT() - 2, 5).length, 2);
        assertEq(lens.bondingRemaining(address(hook)), hook.TIER_COUNT() * hook.tierSize() - amount);
    }

    // ─── reservoir and buyback ────────────────────────────────────────────────

    function test_reservoir_views() public {
        _setReservoir(0.1e18);
        assertEq(ladder.untilNextTrigger(), ladder.TRIGGER_STEP() - 0.1e18);
        assertEq(ladder.nextSpendAmount(), 0);
        _setReservoir(0.4e18);
        assertEq(ladder.untilNextTrigger(), 0);
        assertEq(ladder.nextSpendAmount(), ladder.TRIGGER_STEP(), "floored at one step");
        _setReservoir(10e18);
        assertEq(ladder.nextSpendAmount(), 5e18, "half the pot");
    }

    function test_notifyTax_isOnlyALogLine() public {
        vm.expectEmit(address(ladder));
        emit ToshLadderTreasury.TaxReceived(address(this), 123);
        ladder.notifyTax(123);
        assertEq(ladder.reservoir(), quote.balanceOf(address(ladder)));
    }

    function test_revert_list_notOurToken() public {
        MockQuoteAsset stranger = new MockQuoteAsset();
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenNotLaunchedHere.selector);
        ladder.addLadderToken(address(stranger));
    }

    function test_revert_list_notLaunched() public {
        (ToshToken t2,) = _create("Beta", HARD_CAP, AGENT_CAP);
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.PoolNotLaunched.selector);
        ladder.addLadderToken(address(t2));
    }

    function test_revert_list_twapNotMature() public {
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));
    }

    function test_list_ownerOnly_onceOnly_andDelist() public {
        _matureTwap();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        ladder.addLadderToken(address(token));
        _list(token);
        assertTrue(ladder.isLadderToken(address(token)));
        assertEq(ladder.ladderTokenCount(), 1);
        assertEq(address(ladder.getPoolKey(address(token)).hooks), address(hook));
        assertGt(ladder.legCeiling(address(token)), 0);

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenAlreadyListed.selector);
        ladder.addLadderToken(address(token));

        vm.prank(admin);
        ladder.removeLadderToken(address(token));
        assertFalse(ladder.isLadderToken(address(token)));
        assertEq(ladder.legCeiling(address(token)), 0);
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenNotListed.selector);
        ladder.removeLadderToken(address(token));
    }

    function test_revert_poke_unarmedOrEmpty() public {
        _setReservoir(ladder.TRIGGER_STEP() - 1);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
        _setReservoir(1e18);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
    }

    function test_poke_buysAndBurns_cappedByDepth_andShutsMinting() public {
        _openLadder();
        _list(token);
        _setReservoir(1e18);
        uint256 cap = ladder.legCeiling(address(token));
        uint256 deadBefore = token.balanceOf(DEAD);
        assertGt(hook.maxMintable(), 0);

        ladder.pokeBuyback();

        uint256 spent = 1e18 - ladder.reservoir();
        assertGt(spent, 0);
        assertLe(spent, cap, "one leg is at most 0.5 % of the pool's depth");
        assertGt(token.balanceOf(DEAD), deadBefore, "bought tokens burned");
        assertEq(hook.lastSwapBlock(), block.number, "the buyback is a visible swap");
        assertEq(hook.maxMintable(), 0, "no mint against a price the buyback just moved");
    }

    function test_poke_refusesToFillASandwich() public {
        _matureTwap();
        _list(token);
        _swapBuy(hook, trader, 4e18); // push spot far past the 10 % floor below the TWAP
        _setReservoir(1e18);
        uint256 deadBefore = token.balanceOf(DEAD);
        ladder.pokeBuyback();
        assertEq(ladder.reservoir(), 1e18, "nothing spent at a manipulated price");
        assertEq(token.balanceOf(DEAD), deadBefore);
    }

    function test_piggyback_ridesAUserSwap() public {
        _matureTwap();
        _list(token);
        _setReservoir(1e18);
        uint256 deadBefore = token.balanceOf(DEAD);
        _swapBuy(hook, trader, 0.01e18);
        assertLt(ladder.reservoir(), 1e18, "reservoir spent inside the trader's swap");
        assertGt(token.balanceOf(DEAD), deadBefore);
        assertFalse(ladder.piggybackActive(), "flag cleared");
    }

    function test_piggyback_roundRobinAcrossTokens_andDelistKeepsCursorInRange() public {
        (ToshToken t2, ToshLaunchpadHookV3 h2) = _create("Beta", HARD_CAP, AGENT_CAP);
        _buy(h2, carol, 5e18);
        _launchAsAdmin(h2);
        _matureTwap();
        _list(token);
        _list(t2);

        _setReservoir(1e18);
        uint256 d1 = token.balanceOf(DEAD);
        uint256 d2 = t2.balanceOf(DEAD);
        ladder.pokeBuyback();
        assertGt(token.balanceOf(DEAD), d1, "first leg on the first token");
        assertEq(t2.balanceOf(DEAD), d2);
        assertEq(ladder.currentCursor(), 1);

        _nextBlock();
        _setReservoir(1e18);
        ladder.pokeBuyback();
        assertGt(t2.balanceOf(DEAD), d2, "second leg on the second token");
        assertEq(ladder.currentCursor(), 0);

        vm.prank(admin);
        ladder.removeLadderToken(address(token));
        assertEq(ladder.ladderTokens(0), address(t2), "swap-and-pop");
        assertLt(ladder.currentCursor(), ladder.ladderTokenCount());
        h2;
    }

    function test_revert_treasury_entryPointsAreFenced() public {
        vm.expectRevert(ToshLadderTreasury.OnlyHook.selector);
        ladder.autoPiggybackBuyback();
        vm.expectRevert(ToshLadderTreasury.OnlySelf.selector);
        ladder.executeBuyAndBurn(address(token), 1);
        vm.expectRevert(ToshLadderTreasury.OnlyVault.selector);
        ladder.lockAcquired("");

        // A registered hook outside any lock is a no-op, never a revert.
        _setReservoir(1e18);
        vm.prank(address(hook));
        ladder.autoPiggybackBuyback();
        assertEq(ladder.reservoir(), 1e18);
    }

    function test_revert_treasury_ownership() public {
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.OwnershipCannotBeRenounced.selector);
        ladder.renounceOwnership();
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.FactoryAlreadySet.selector);
        ladder.setFactory(address(1));
    }

    function test_hookTriggerMirrorsItsTreasury() public view {
        assertEq(hook.PIGGYBACK_TRIGGER_STEP(), ladder.TRIGGER_STEP());
    }

    function test_revert_treasury_constructorZeros() public {
        vm.expectRevert(ToshLadderTreasury.ZeroAddress.selector);
        new ToshLadderTreasury(address(0), address(vault), admin, address(quote), address(0), 0.3 ether);
        vm.expectRevert(ToshLadderTreasury.ZeroAddress.selector);
        new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote), address(0), 0);
        ToshLadderTreasury fresh =
            new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote), address(0), 300e18);
        assertEq(fresh.TRIGGER_STEP(), 300e18, "step is per deployment");
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.ZeroAddress.selector);
        fresh.setFactory(address(0));
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.FactoryNotSet.selector);
        fresh.addLadderToken(address(token));
        vm.prank(address(hook));
        vm.expectRevert(ToshLadderTreasury.OnlyHook.selector);
        fresh.autoPiggybackBuyback();
    }

    // ─── genesis LP fees and the Circuit vault ────────────────────────────────

    function test_genesisFees_quoteToTheVault_tokensToTheFire() public {
        _swapBuy(hook, trader, 2e18);
        _nextBlock();
        _swapSell(hook, alice, 50_000e18);
        address rv = hook.projectAdmin();
        uint256 qBefore = quote.balanceOf(rv);
        uint256 deadBefore = token.balanceOf(DEAD);
        hook.collectGenesisFees();
        assertGt(quote.balanceOf(rv), qBefore, "0.3 % pool fee on buys");
        assertGt(token.balanceOf(DEAD), deadBefore, "token-side fees burned");
    }

    function test_revert_collectGenesisFees_beforeLaunch() public {
        (, ToshLaunchpadHookV3 h2) = _create("Beta", HARD_CAP, AGENT_CAP);
        vm.expectRevert(ToshLaunchpadHookV3.NotLaunched.selector);
        h2.collectGenesisFees();
    }

    function test_circuit_saleSettlesTheSeller_buyerStartsEmpty() public {
        _swapBuy(hook, trader, 2e18);
        _nextBlock();
        uint256 amount = hook.tierSize() / 2;
        uint256 cost = lens.quoteMint(address(hook), amount);
        vm.prank(bob, bob);
        hook.mintBondingCurve(amount, cost);

        CircuitNFT nft = CircuitNFT(factory.circuitNFT());
        uint256 id = factory.circuitOf(address(hook));
        CircuitRevenueVault rv = CircuitRevenueVault(hook.projectAdmin());
        assertEq(address(rv), nft.vaultOf(id));
        assertEq(address(rv), factory.predictVaultAddress(id));
        assertEq(rv.holder(), dev);
        uint256 inVault = quote.balanceOf(address(rv));
        assertGt(inVault, 0);

        uint256 devBefore = quote.balanceOf(dev);
        vm.prank(dev);
        nft.transferFrom(dev, carol, id);
        assertGe(quote.balanceOf(dev) - devBefore, inVault, "seller paid out, fees swept in first");
        assertEq(quote.balanceOf(address(rv)), 0, "buyer starts from an empty vault");
        assertEq(rv.holder(), carol);
    }

    function test_circuit_withdraw_holderOnly() public {
        CircuitRevenueVault rv = CircuitRevenueVault(hook.projectAdmin());
        MockQuoteAsset other = new MockQuoteAsset();
        other.mint(address(rv), 7e18);

        vm.prank(trader);
        vm.expectRevert(CircuitRevenueVault.NotCircuitHolder.selector);
        rv.withdraw(address(other), trader, 1);

        vm.startPrank(dev);
        vm.expectRevert(CircuitRevenueVault.ZeroAmount.selector);
        rv.withdraw(address(other), dev, 0);
        vm.expectRevert(CircuitRevenueVault.ZeroAddress.selector);
        rv.withdraw(address(0), dev, 1);
        vm.expectRevert(CircuitRevenueVault.ZeroAddress.selector);
        rv.withdraw(address(other), address(0), 1);
        assertEq(rv.withdraw(address(other), dev, 2e18), 2e18);
        assertEq(rv.withdraw(address(other), dev, type(uint256).max), 5e18, "max takes the rest");
        vm.stopPrank();
        assertEq(other.balanceOf(dev), 7e18);
    }

    function test_revert_circuit_settleAndImplementationFenced() public {
        CircuitRevenueVault rv = CircuitRevenueVault(hook.projectAdmin());
        vm.expectRevert(CircuitRevenueVault.OnlyCircuit.selector);
        rv.settle(address(this));

        CircuitRevenueVault impl = CircuitRevenueVault(factory.vaultImplementation());
        vm.expectRevert(CircuitRevenueVault.NotAClone.selector);
        impl.withdraw(address(quote), dev, 1);
        vm.expectRevert(CircuitRevenueVault.NotAClone.selector);
        impl.settle(dev);

        CircuitNFT nft = CircuitNFT(factory.circuitNFT());
        vm.expectRevert(CircuitNFT.OnlyFactory.selector);
        nft.mint(address(this));
    }

    function _id(ToshLaunchpadHookV3 h) internal view returns (PoolId) {
        return h.getPoolKey().toId();
    }
}
