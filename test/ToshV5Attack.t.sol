// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice RED-TEAM PROBES — adversarial exploration of the v5.0 "Scheme B"
///         (8.4 M genesis / 12.6 M ladder) configuration.
///
/// @dev    These are deliberately written as PROBES, not as invariant tests:
///         each one drives the system into an adversarial corner and asserts
///         what the code ACTUALLY does, so a future change that alters the
///         answer breaks the build and forces a conscious decision.
contract ToshV5AttackTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xBEEF_CAFE;
    address internal pogSigner;

    PoolManager internal poolManager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liqRouter;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    uint256 internal constant SOFT_CAP = 1 ether;
    uint256 internal constant POG_CAP = 100 ether;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        poolManager = new PoolManager(admin);
        swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));
        liqRouter = new PoolModifyLiquidityTest(IPoolManager(address(poolManager)));

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), admin);
        factory = new ToshFactory(address(poolManager), pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));
        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        vm.deal(creator, 1000 ether);
        vm.deal(alice, 1000 ether);
        vm.deal(attacker, 10_000 ether);
    }

    // ─── Harness ──────────────────────────────────────────────────────────────

    function _mineSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("no salt");
    }

    function _registerPoG(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);
        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    /// @dev Create + fund + launch, WITHOUT warping past the launch block, so
    ///      probes can inspect the state of the very block the pool opens in.
    function _launchProject(uint256 raise) internal returns (ToshToken token, ToshLaunchpadHook hook) {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (address t, address h) =
            factory.createLaunch{value: fee}("Probe", "PRB", projTreasury, projTreasury, salt, fee, 24 hours);
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));

        if (factory.pogQuota(alice) == 0) _registerPoG(alice, POG_CAP);
        vm.prank(alice);
        factory.deposit{value: raise}(address(hook), address(0));

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Buy `ethIn` worth of token through the real V4 router (exact input).
    function _buy(ToshLaunchpadHook hook, address who, uint256 ethIn) internal {
        PoolKey memory key = hook.getPoolKey();
        vm.prank(who);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE A — is Phase 2 really "SHUT" in the launch block?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The SHELF_PREMIUM_BPS natspec claimed:
    //
    //   "at launch `spot == p0` exactly, which sits ON the boundary rather than
    //    inside it, so Phase 2 opens SHUT"
    //
    // The gate is `if (tierPrice > ceiling) revert`, a STRICT comparison, and
    // both `shelfP0` and `ceiling` are `(x * 10500) / 10000` of the same `p0`.
    // Sitting ON the boundary therefore PASSED, and at a 10 ETH raise it did:
    // shelf 0 (3 150 tokens) was mintable in the launch block.
    //
    // FIX.  `launch()` now stamps `lastSwapBlock`, closing the launch block
    // outright regardless of which side of `p0` the truncated spot lands on.
    function test_probeA_shelfZeroInLaunchBlock() public {
        (, ToshLaunchpadHook hook) = _launchProject(10 ether);

        (,,, uint256 spot,, uint256 ceiling,) = hook.tierStatus();

        // The boundary condition that used to let it through is still there —
        // the fix does not pretend the arithmetic changed.
        assertEq(hook.tierPriceAt(0), ceiling, "shelf 0 still sits exactly ON the ceiling");
        assertGe(spot, hook.p0(), "and at this raise spot rounds up, not down");

        assertEq(hook.lastSwapBlock(), block.number, "launch stamps the block");
        assertEq(hook.maxMintable(), 0, "so the view reports nothing available");

        uint256 quote = hook.quoteMint(1e18);
        vm.prank(attacker);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve{value: quote}(1e18);

        // ...and it opens normally one block later, once the market qualifies.
        _nextBlock();
        assertEq(hook.maxMintable(), hook.TIER_SIZE(), "next block, shelf 0 is on sale as designed");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE B — how fast can the TWAP be re-anchored to a pumped price?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The hook keeps TWO checkpoints and rolls `_prev <- _cur` whenever a swap
    // lands `>= TWAP_WINDOW` after `_cur`.  An attacker who controls WHEN that
    // roll happens can collapse the averaging window down to the minimum.
    function test_probeB_twapReanchorSpeed() public {
        (, ToshLaunchpadHook hook) = _launchProject(100 ether);

        uint256 t0 = block.timestamp;
        console2.log("p0", hook.p0());

        // 1. Pump hard.
        _nextBlock();
        _buy(hook, attacker, 200 ether);
        (,,, uint256 spotAfterPump,, uint256 ceilAfterPump,) = hook.tierStatus();
        console2.log("spot after pump ", spotAfterPump);
        console2.log("ceil after pump ", ceilAfterPump);
        console2.log("maxMintable now ", hook.maxMintable());

        // 2. Hold for exactly one TWAP_WINDOW, then poke with a dust swap so the
        //    checkpoint rolls to the pumped era.
        uint32 w = hook.TWAP_WINDOW();
        vm.warp(t0 + w);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        vm.warp(t0 + 2 * uint256(w) + 1);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        vm.warp(t0 + 2 * uint256(w) + 2);
        _nextBlock();
        (,,, uint256 spot2, uint256 twap2, uint256 ceil2,) = hook.tierStatus();
        console2.log("--- two windows after launch, one after the pump ---");
        console2.log("TWAP_WINDOW", uint256(w));
        console2.log("spot ", spot2);
        console2.log("twap ", twap2);
        console2.log("ceil ", ceil2);
        console2.log("maxMintable", hook.maxMintable());

        // The depth of the oracle IS TWAP_WINDOW: hold a price for one and the
        // average converges on it.  Raising the constant raises the price of
        // the hold; it does not change the shape.  Pinned so a future edit to
        // TWAP_WINDOW has to restate what it bought.
        assertApproxEqRel(twap2, spot2, 0.001e18, "one held window re-anchors the TWAP onto spot");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE B′ — the OTHER end of the window: what happens when nobody trades?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PROBE B above measures how far the averaging window can be COLLAPSED. It
    // cannot see this case, and the reason is worth stating: its fixture hand-
    // feeds a dust swap at `t0 + w` and another at `t0 + 2w + 1`, which is
    // exactly the trading pattern that keeps the window inside its documented
    // `[TWAP_WINDOW, 2 x TWAP_WINDOW)` bracket. Remove those two swaps and the
    // same fixture produces a multi-day window. So the suite pinned the lower
    // bound and left the upper one unasserted.
    //
    // The upper bound is not enforced by the clock. `_writeObservation` rolls
    // the checkpoint only when a SWAP arrives, so on a pool that goes quiet
    // `span = now - _prevCheckpointTs` grows without limit — measured at
    // 608_400 s (7.04 days) on a weekly-traded pool.
    //
    // The harm is in the treasury. `_buybackSqrtFloor` anchors every leg at
    // `0.9 x twapSqrt`, so a fossilised high average puts the floor ABOVE spot,
    // V4 rejects the leg with `PriceLimitAlreadyExceeded`, and the treasury
    // skips. Measured before the fix: a floor 4.81x above spot, decaying only
    // through the `lastTick` extrapolation term, with the first fill on DAY
    // 105. The token that gets starved this way is by definition the thinly
    // traded one — precisely the one the buyback exists to support.
    //
    // The fix is not to clamp `span`: `delta` spans the full period, so
    // dividing it by a truncated span would report an average that never
    // happened. It is that a pool with NO trade in a full window has a
    // trivially known average — the price was flat at `lastTick` for the whole
    // window, so that IS the TWAP.
    function test_probeB2_quietPoolTwapDoesNotFossilise() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);
        PoolKey memory key = hook.getPoolKey();
        uint256 t0 = block.timestamp;

        // A long, HIGH-priced history, laid down by sparse trading so the
        // stale checkpoint ends up a week behind rather than 30 minutes.
        _nextBlock();
        _buy(hook, attacker, 200 ether);

        vm.warp(t0 + 7 days);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        // The drawdown, then silence.
        vm.warp(t0 + 14 days);
        _nextBlock();
        _dumpAll(hook, token);

        vm.warp(t0 + 14 days + 2000);
        _nextBlock();

        (uint160 spotSqrt,,,) = IPoolManager(address(poolManager)).getSlot0(key.toId());
        uint160 twapSqrt = hook.twapSqrtPriceX96();

        console2.log("quiet for (s)   ", uint256(2000));
        console2.log("spot sqrt       ", uint256(spotSqrt));
        console2.log("twap sqrt       ", uint256(twapSqrt));
        console2.log("twap as % of spot", (uint256(twapSqrt) * 100) / uint256(spotSqrt));

        // Nothing has traded for longer than a full window, so the trailing
        // window is flat by construction and the average is the spot price.
        assertApproxEqRel(
            uint256(twapSqrt),
            uint256(spotSqrt),
            0.001e18,
            "a pool that has not traded for a full window reports a fossilised average"
        );

        // The consequence, asserted directly: the floor must not lock the
        // reservoir out of a token just because that token is quiet.
        uint256 burned = _armAndPoke(token);
        assertGt(burned, 0, "the buyback skipped a quiet pool because its TWAP had fossilised");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE C — what does the ladder release at 2x, against WHICH float?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The Scheme-B docs report the 2x release as a share of GENESIS_SUPPLY
    // (8.4 M).  But 3.78 M of that is locked inside the genesis LP position,
    // which no code path can remove.  Measure both denominators.
    function test_probeC_releaseDenominators() public view {
        uint256 GEN = 8_400_000e18;
        uint256 CLAIM = 4_620_000e18;
        uint256 LP = 3_780_000e18;
        uint256 TIER_SIZE = 3_150e18;

        // Shelves unlocked at a price multiple R: STEP^i <= R.
        uint256 unlockedAtTwoX = _shelvesUnlockedAt(2e18);
        uint256 released = unlockedAtTwoX * TIER_SIZE;

        console2.log("shelves unlocked at 2x", unlockedAtTwoX);
        console2.log("tokens released       ", released);
        console2.log("bps of GENESIS_SUPPLY ", (released * 10_000) / GEN);
        console2.log("bps of CLAIM float    ", (released * 10_000) / CLAIM);
        console2.log("bps of claim+released ", (released * 10_000) / (CLAIM + released));
        console2.log("LP locked (not float) ", LP);

        // The gap between the headline figure and the honest one is the finding,
        // so pin the gap rather than either number on its own.  13.7 % is what
        // the Scheme-B write-up quoted; 24.9 % is what the market is asked to
        // absorb, because the 3.78 M LP side never trades.
        assertEq((released * 10_000) / GEN, 1368, "headline: 13.7 % of GENESIS_SUPPLY");
        assertEq((released * 10_000) / CLAIM, 2488, "honest: 24.9 % of the tradeable float");
        assertEq(CLAIM + LP, GEN, "the two denominators differ by exactly the locked LP");
        assertGt(
            (released * 10_000) / CLAIM,
            (released * 10_000) / GEN,
            "any restatement must keep reporting the float denominator too"
        );
    }

    /// @dev Count of shelves whose price multiple `STEP^i` is <= `multiple`,
    ///      i.e. indices 0..n-1 (shelf 0 is always unlocked, STEP^0 == 1).
    function _shelvesUnlockedAt(uint256 multipleE18) internal pure returns (uint256 n) {
        uint256 STEP = 1_001_902_508_266_805_824;
        uint256 acc = 1e18;
        n = 1;
        while (n < 4000) {
            uint256 next = (acc * STEP) / 1e18;
            if (next > multipleE18) break;
            acc = next;
            ++n;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G — atomically sandwich the treasury's piggyback buyback
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `autoPiggybackBuyback` fires from EVERY Tosh hook's `afterSwap`, so the
    // attacker chooses the moment it runs simply by swapping.  The buyback's
    // only protection is `_buybackSqrtFloor` = 0.9 x twapSqrt, which permits the
    // pool to sit ~23 % above TWAP in price terms before a leg stops filling.
    //
    // The spend is `max(1 ETH, 10 % of the reservoir)`, and a leg is always
    // that divided by BATCH_SIZE=3 — by the CONSTANT, not by how many tokens
    // happen to be listed, so a one-token ladder is handed a third of the
    // cheque rather than all of it.  (This probe measures it: a 100 ETH
    // reservoir sizes a 10 ETH cycle and spends 3.34 ETH on its single listed
    // pool.)
    //
    // What that leaves is a prize that still grows without limit.  0.33 ETH is
    // the per-leg FLOOR — what a reservoir between 1 and 10 ETH offers, where
    // the 1 ETH minimum is doing the sizing — and past 10 ETH the leg is
    // `balance / 30` and climbs with the pot.  The natspec's "0.33 ETH they
    // are trying to skim" is therefore the bottom of the range, not a bound on
    // it, and it understates a full treasury by whatever multiple that
    // treasury has grown by: 10x at the 100 ETH modelled here.
    function test_probeG_sandwichThePiggyback() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);

        // Mature the TWAP so the buyback floor is live rather than unbounded.
        _nextBlock();
        _buy(hook, alice, 1 ether);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));

        // Fund the reservoir.  100 ETH is a modest figure for a platform that
        // routes every launch fee, every 1 % shelf cut and the 70 bps reservoir
        // share of every buy tax into a contract with no withdraw path.
        vm.deal(address(ladder), 100 ether);
        console2.log("reservoir           ", address(ladder).balance);
        console2.log("spend this cycle    ", ladder.nextSpendAmount());
        console2.log("listed tokens       ", ladder.ladderTokenCount());

        uint256 pumpSize = 40 ether;

        // ── Control: identical round trip with the reservoir disarmed ────────
        uint256 snap = vm.snapshotState();
        vm.deal(address(ladder), 0);
        console2.log("=== CONTROL (reservoir emptied) ===");
        int256 controlPnl = _roundTrip(hook, token, pumpSize);
        vm.revertToState(snap);

        // ── Attack: same round trip, reservoir armed ─────────────────────────
        console2.log("=== ATTACK (reservoir armed) ===");
        uint256 burnedBefore = token.balanceOf(DEAD);
        int256 attackPnl = _roundTrip(hook, token, pumpSize);
        uint256 burnedByTreasury = token.balanceOf(DEAD) - burnedBefore;

        console2.log("--- round trip of 40 ETH through the pool ---");
        console2.log("control pnl:");
        console2.logInt(controlPnl);
        console2.log("attack pnl:");
        console2.logInt(attackPnl);
        console2.log("reservoir left      ", address(ladder).balance);
        console2.log("tokens sent to 0xdead", burnedByTreasury);

        int256 edge = attackPnl - controlPnl;
        console2.log("edge from sandwiching the buyback:");
        console2.logInt(edge);
    }

    /// @dev Buy `ethIn` of the token then immediately sell the entire position
    ///      back, in the same block.  Returns the attacker's ETH P&L.
    function _roundTrip(ToshLaunchpadHook hook, ToshToken token, uint256 ethIn) internal returns (int256) {
        uint256 ethBefore = attacker.balance;
        PoolKey memory key = hook.getPoolKey();

        console2.log("  reservoir at entry ", address(ladder).balance);
        console2.log("  attacker eth       ", ethBefore);
        console2.log("  attacker tok       ", token.balanceOf(attacker));

        _buy(hook, attacker, ethIn);

        console2.log("  reservoir post-buy ", address(ladder).balance);
        uint256 bought = token.balanceOf(attacker);
        console2.log("  bought             ", bought);

        vm.startPrank(attacker);
        token.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(bought), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        console2.log("  reservoir post-sell", address(ladder).balance);
        console2.log("  attacker eth after ", attacker.balance);

        return int256(attacker.balance) - int256(ethBefore);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G′ — where exactly does the band PROBE G measures stop?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PROBE G reports an edge and asserts nothing, which is the right shape for
    // a probe whose answer is a number.  What it leaves unheld is the WIDTH of
    // the band, and the coverage elsewhere does not close that:
    // `test_buyback_refusesToFillIntoAManipulatedPrice` @ `test/ToshV5.t.sol`
    // does catch a deleted `sqrtPriceLimitX96` argument, but it clears the
    // bound by shoving 120 ETH through the pool — far enough past the floor to
    // still clear one five times wider.  Retuning
    // `MAX_BUYBACK_SQRT_DEVIATION_BPS` from 1000 to 5000 leaves that test
    // green.  Established by mutation, not by reading it.
    //
    // So bracket the band from both sides rather than overshooting it: park the
    // pool at a deviation the constant must ALLOW, then at one it must REFUSE.
    // Both targets are written as absolute fractions of the TWAP on purpose —
    // deriving them from `MAX_BUYBACK_SQRT_DEVIATION_BPS` would move the goal
    // posts along with the constant and reopen exactly the hole this closes.
    function test_probeG2_bandEdgeSitsWhereTheConstantSaysItDoes() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);

        // Same TWAP-maturing dance as PROBE G: one real trade, a full window,
        // then a dust trade to roll the observation forward.
        _nextBlock();
        _buy(hook, alice, 1 ether);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        uint160 twapSqrt = hook.twapSqrtPriceX96();
        assertGt(twapSqrt, 0, "fixture needs a matured TWAP, or the floor disables itself by design");

        uint256 snap = vm.snapshotState();

        // ── 500 bps of sqrt deviation: half the permitted travel ─────────────
        _parkAt(hook, (uint256(twapSqrt) * 9500) / 10_000);
        uint256 filled = _armAndPoke(token);
        console2.log("burned at  500 bps (inside) ", filled);
        assertGt(filled, 0, "a pool inside the band must still be bought and burned");
        assertLt(address(ladder).balance, 100 ether, "and the reservoir must actually spend");

        vm.revertToState(snap);

        // ── 1200 bps: past the floor, yet nowhere near a 5000 bps one ────────
        _parkAt(hook, (uint256(twapSqrt) * 8800) / 10_000);
        uint256 refused = _armAndPoke(token);
        console2.log("burned at 1200 bps (outside)", refused);
        assertEq(refused, 0, "a pool past the band must not be bought into at all");
        assertEq(address(ladder).balance, 100 ether, "and the unspent ETH must stay in the reservoir");
    }

    /// @dev Park the pool at EXACTLY `targetSqrt` by handing V4 a swap it cannot
    ///      finish: an oversized exact input bounded by the target, which fills
    ///      until the price touches the limit and then stops there.  Sizing a
    ///      plain buy to land on a chosen deviation would mean solving the
    ///      curve for it; letting the limit do the work is exact, and being
    ///      exact is the whole point of a bracket.
    ///
    ///      A pump this size pays well over 1 ETH of buy tax into the reservoir
    ///      during its own `beforeSwap`, so its `afterSwap` arrives with the
    ///      engine armed.  That is why the token is not listed until after this
    ///      returns: an unlisted ladder makes `_runPiggyback` return on
    ///      `total == 0`, and the pool stays exactly where the limit left it.
    ///      Listing first cost ~120 bps of unrequested extra travel — a leg
    ///      firing from the pump itself, before the poke under test ever ran.
    function _parkAt(ToshLaunchpadHook hook, uint256 targetSqrt) internal {
        PoolKey memory key = hook.getPoolKey();
        uint256 offered = 5000 ether;
        vm.deal(attacker, offered + 1 ether);

        vm.prank(attacker);
        swapRouter.swap{value: offered}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(offered), sqrtPriceLimitX96: uint160(targetSqrt)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        (uint160 spot,,,) = IPoolManager(address(poolManager)).getSlot0(key.toId());
        assertEq(uint256(spot), targetSqrt, "the limit must park the pool exactly on the requested deviation");
    }

    /// @dev List the parked pool, hand the reservoir a known 100 ETH — rather
    ///      than whatever the pump's tax happened to leave — and fire one poke.
    ///
    ///      The poke comes from `pokeBuyback` rather than from a trigger swap
    ///      because it opens its own unlock frame, so nothing moves the very
    ///      price under test on the way in.  A leg the floor rejects reverts
    ///      into `BuybackSkipped` instead of bubbling up, so the poke succeeds
    ///      either way and the burn is the only signal worth reading.
    function _armAndPoke(ToshToken token) internal returns (uint256) {
        vm.prank(admin);
        ladder.addLadderToken(address(token));
        vm.deal(address(ladder), 100 ether);

        uint256 before = token.balanceOf(DEAD);
        _nextBlock();
        vm.prank(attacker);
        ladder.pokeBuyback();
        return token.balanceOf(DEAD) - before;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G″ — for the first 1800 s of a pool's life the band is not there
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ── CLOSED IN SOURCE, 2026-09-11 ─────────────────────────────────────────
    //
    // The argument below was accepted rather than answered.  `addLadderToken`
    // now reads `twapSqrtPriceX96()` itself and reverts `TwapNotMature` unless
    // it answers non-zero, so the state arm A used to drive cannot be entered
    // through the only door that reaches it.  `SECURITY_AUDIT.md` §2.3 records
    // the trade this replaced.
    //
    // What arm A used to measure, kept because it is the reason the gate exists
    // and not a historical curiosity: one pool parked 1500 bps out, the full
    // 3.33 ETH leg clearing at a deviation the band forbids, 0.93 ETH of it
    // recovered by whoever parked the price, repeatable per block because
    // `pokeBuyback` has no cooldown.  Arm A now pins the refusal instead, at
    // the same park, so the gate is shown landing on the attack rather than
    // beside it.
    //
    // TWO LIMITS, so the gate is not read as more than it is.
    //
    // `_buybackSqrtFloor` still answers a REVERTING `twapSqrtPriceX96()` with
    // "unbounded", and the gate only proves the getter answered once, at
    // listing time.  On chain that door is not practically reachable:
    // `nowTs - _prevCheckpointTs` cannot underflow where time only moves
    // forward, and nothing else in the getter reverts.  That is why it is left
    // as the audit left it.  It is reachable in TESTS, and was reached —
    // `_warpBy` in `ToshV5.t.sol` documents the backward warp that did it, and
    // the three tests that had been measuring an unbounded buyback as a result.
    //
    // The live treasury at 0x99aD248dD15498957B864Fd79917F0E103Aa78F7 predates
    // this gate and cannot be given it: `ToshFactory.ladderTreasury` is
    // `immutable` and is baked into the hook implementation that every launch
    // clones, so replacing the treasury means replacing the platform.  The gate
    // therefore arrives with the next deployment, not with this commit, and
    // until then the operational rule plus `STATE-07` are still what hold the
    // exposure shut.
    //
    // ─────────────────────────────────────────────────────────────────────────
    //
    // This probe RECORDED AN EXPOSURE.  It was not here to bless the fallback it
    // measured, and the numbers below are the argument that closed it.
    //
    // `_buybackSqrtFloor` has two ways to end up returning `MIN_SQRT_PRICE + 1`
    // — no bound at all — and its natspec defends them with one sentence:
    // refusing to buy "would be the worse failure: the reservoir would stall
    // permanently on any pool whose hook predates this interface."
    //
    // That sentence is true of the `catch` branch, where a hook does not answer
    // `twapSqrtPriceX96()` at all and never will.  It is NOT true of the
    // `twapSqrt == 0` branch this probe drives.  Reading
    // `_twapSqrtPriceX96`: the answer is 0 exactly while
    // `block.timestamp - _prevCheckpointTs < TWAP_WINDOW`, both checkpoints are
    // stamped at `launch()`, and `_prevCheckpointTs` only ever rolls onto a
    // `_curCheckpointTs` that was already a full window old.  So the immature
    // state is one-shot and clock-bound: the 1800 s after launch, never
    // re-enterable, and — because the accumulator extrapolates from `lastTick`
    // — it closes on the clock alone, with no swap required to close it.
    // "Stall permanently" is therefore the wrong cost for this branch.  The
    // real cost of refusing is that one freshly launched token's first buybacks
    // are deferred by up to half an hour, using the `BuybackSkipped` path that
    // already exists and already leaves the ETH in the reservoir for the next
    // cycle.
    //
    // What is bought with that half hour is the removal of the only
    // anti-sandwich control the buyback has, on the pool least able to absorb
    // it: a pool whose liquidity is whatever the genesis raise seeded and whose
    // price a small pump moves a long way.  The two arms below are the same
    // pool, parked at the same deviation, with the same reservoir and the same
    // attacker actions.  The only difference is whether 1801 seconds have
    // passed — and that flips the leg from "refused outright" to "fills the
    // whole cheque".
    //
    // Scope, stated rather than implied: arm A pins that the leg is not bounded
    // by anything anchored to the TWAP, and not bounded by spot either at the
    // one deviation a spot anchor forbids outright (zero travel).  A bound
    // anchored to spot but looser than the leg's OWN travel — logged below, and
    // small on a pool this deep — would still slip past.  Left there
    // deliberately: such a bound moves with the very quantity a sandwicher
    // displaces, so it is not the control being defended, and pretending to
    // catch it would mean sizing the fixture around the mutation instead of
    // around the attack.
    function test_probeG3_immatureTwapIsRefusedAtListing() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);
        PoolKey memory key = hook.getPoolKey();
        (uint160 openingSqrt,,,) = IPoolManager(address(poolManager)).getSlot0(key.toId());
        uint256 launchTs = block.timestamp;

        // 1500 bps below the opening sqrt price: half again as far out as
        // `MAX_BUYBACK_SQRT_DEVIATION_BPS` permits, so a live band has to refuse
        // it.  An absolute fraction rather than one derived from the constant,
        // for the reason PROBE G′ gives — a derived target moves with the
        // constant and stops testing it.
        uint256 target = (uint256(openingSqrt) * 8500) / 10_000;
        uint256 leg = (100 ether * ladder.SPEND_BPS()) / 10_000 / ladder.BATCH_SIZE();

        uint256 snap = vm.snapshotState();

        // ── Arm A: inside the launch window there is no TWAP, so no listing ──
        assertEq(hook.twapSqrtPriceX96(), 0, "premise: a pool in its first window has no TWAP to anchor to");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));
        assertEq(ladder.ladderTokenCount(), 0, "nothing may be listed out of the immature window");

        // Parking the price first changes nothing, and that is the point.  The
        // gate is not a judgement about whether the price looks honest at
        // listing time; it refuses because there is no reading to judge it
        // against.  This is the exact state arm A used to spend the cheque in.
        _parkAt(hook, target);
        assertEq(hook.twapSqrtPriceX96(), 0, "a swap does not mature the window, only the clock does");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));

        // The reservoir is not empty here — the 5000 ETH pump paid tax into it
        // on the way past — so the refusal has to be shown to bite on the
        // spending side too, not just on the bookkeeping.  With nothing listed
        // there is nowhere for that ETH to go, and the poke says so.
        assertGt(address(ladder).balance, 0, "the pump did fund the reservoir");
        vm.prank(attacker);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();

        vm.revertToState(snap);

        // ── Arm B: the identical park, 1801 seconds later ────────────────────
        vm.warp(launchTs + hook.TWAP_WINDOW() + 1);
        _nextBlock();
        uint160 twapSqrt = hook.twapSqrtPriceX96();
        assertGt(twapSqrt, 0, "the window closes on the clock alone, with no swap needed to mature it");
        assertLt(target, (uint256(twapSqrt) * 9000) / 10_000, "and the park must sit outside the live band");
        _parkAt(hook, target);
        uint256 burnedB = _armAndPoke(token);
        uint256 spentB = 100 ether - address(ladder).balance;
        uint256 proceedsB = _dumpAll(hook, token);

        console2.log("leg offered                 ", leg);
        console2.log("arm B (TWAP live) eth spent ", spentB);
        console2.log("arm B (TWAP live) burned    ", burnedB);
        console2.log("attacker dump, arm B        ", proceedsB);

        // Past the window the listing is accepted, and the band is then what
        // refuses the deviation — so the two controls are shown to be
        // independent.  The gate decides WHETHER a pool is eligible at all; the
        // band decides what may be paid on any given leg.  Neither substitutes
        // for the other, which is why arm A does not simply assert on spend.
        assertEq(spentB, 0, "with a TWAP the identical deviation is refused outright");
        assertEq(burnedB, 0, "so nothing is bought and nothing is burned");
    }

    /// @dev Sell the attacker's whole position back and return the ETH it
    ///      fetched.  The reservoir is emptied first: the dump's own `afterSwap`
    ///      would otherwise fire a SECOND leg, bounded in one arm and unbounded
    ///      in the other, and that difference would be mixed into the figure
    ///      under measurement.  What is being measured is what the first leg
    ///      handed back.
    function _dumpAll(ToshLaunchpadHook hook, ToshToken token) internal returns (uint256) {
        vm.deal(address(ladder), 0);

        uint256 bal = token.balanceOf(attacker);
        uint256 ethBefore = attacker.balance;

        vm.startPrank(attacker);
        token.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            hook.getPoolKey(),
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(bal), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        return attacker.balance - ethBefore;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE H — an untaxed parallel venue for the same token
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `beforeInitialize` stops anyone opening a pool THAT USES THIS HOOK.  It
    // says nothing about a HOOKLESS pool over the same ERC-20, which V4 lets
    // anybody create.  Such a pool pays no 1 % tax, feeds no oracle, and
    // funds no buyback.
    function test_probeH_hooklessParallelPool() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);
        _nextBlock();
        _buy(hook, alice, 20 ether);

        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        uint256 treasuryBefore = address(ladder).balance;

        // A stranger can open it.  `beforeInitialize` is never consulted,
        // because V4 only calls a hook for pools that name that hook.
        vm.prank(attacker);
        poolManager.initialize(rogue, TickMath.getSqrtPriceAtTick(0));
        console2.log("rogue hookless ETH/token pool initialised by a stranger");

        assertEq(address(ladder).balance, treasuryBefore, "the rogue venue funds no buyback");

        // ACCEPTED, NOT FIXED — and the assertions below say so out loud.
        //
        // There is no contract-level defence: the token is a plain ERC-20 with
        // no transfer hook, so any fee tier, any hook (or none), any seeder.
        // What the protocol keeps instead is DEPTH — the genesis LP position is
        // locked in the official pool forever — and depth is what makes
        // `_safeReferencePrice` worth reading, since it is single-venue.
        //
        // If this ever stops holding, the exposure is not the lost 1 %: it is
        // that the anti-spike gate is measured against a book that has thinned.
        assertEq(uint256(uint160(address(rogue.hooks))), 0, "the rogue pool is genuinely hookless, by construction");
        assertGt(
            token.balanceOf(address(poolManager)),
            0,
            "the official pool still holds the permanently locked genesis liquidity"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE I — token left stranded in the hook after seeding the LP
    // ══════════════════════════════════════════════════════════════════════════
    function test_probeI_strandedGenesisTokens() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);

        uint256 held = token.balanceOf(address(hook));
        uint256 claimSide = hook.GENESIS_CLAIM_SUPPLY();
        console2.log("hook token balance ", held);
        console2.log("GENESIS_CLAIM_SUPPLY", claimSide);
        console2.log("stranded above claim side", held > claimSide ? held - claimSide : 0);
        console2.log("in pool            ", token.balanceOf(address(poolManager)));

        // Now drain the claim side and see what can never leave.
        vm.prank(alice);
        hook.claimGenesis();
        uint256 stranded = token.balanceOf(address(hook));
        console2.log("hook balance after sole depositor claims", stranded);

        // ACCEPTED, NOT FIXED — but note WHERE the dust comes from, because the
        // obvious guess is wrong.  It is not the pro-rata claim rounding down:
        // the sole depositor receives the claim pool to the wei.  It is the LP
        // seed, where V4's liquidity math accepts marginally less than
        // `GENESIS_LP_SUPPLY`, and the remainder stays in the hook.
        //
        // There is no rescue path, on purpose — a rescue path is a withdrawal
        // path wearing a different name, which is the same trade the treasury
        // makes by having no `sweep`.  Bounded rather than merely observed, so
        // "dust" cannot quietly grow into a number worth caring about: 186
        // wei-tokens against a 4.62 M pool is about 1 part in 2.5e22.
        assertEq(token.balanceOf(alice), claimSide, "the sole depositor gets the entire claim pool, to the wei");
        assertLt(stranded, 1e12, "so the residue is LP-seed remainder, and must stay in the dust regime");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE M — "the ladder opens locked" is a 1-wei coin flip, not a property
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `test_ladderOpensLockedAtLaunch` asserts `maxMintable() == 0` in the launch
    // block and passes — but it only ever runs one raise size (SOFT_CAP, 1 ETH).
    //
    // The gate is `tierPrice > ceiling`, strict.  `shelfP0` and `ceiling` are the
    // SAME expression `(x * 10500) / 10000` applied to `p0` and to
    // `min(spot, p0)`.  So the launch block is locked if and only if the
    // round-tripped `spot` lands strictly BELOW `p0`, which is decided by
    // truncation inside `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken` and varies
    // with the raise.  Sweep it.
    function test_probeM_launchBlockLockIsRaiseDependent() public {
        uint256 unlockedCount;
        uint256 n;

        for (uint256 i = 1; i <= 24; ++i) {
            uint256 raise = i * 1 ether;
            uint256 snap = vm.snapshotState();

            (, ToshLaunchpadHook hook) = _launchProject(raise);
            uint256 p0 = hook.p0();
            (,,, uint256 spot,,,) = hook.tierStatus();
            uint256 openTokens = hook.maxMintable();

            if (openTokens > 0) {
                ++unlockedCount;
                console2.log("raise ETH / OPEN / tokens mintable in launch block:", i, openTokens);
            } else {
                console2.log("raise ETH / locked:", i);
            }
            console2.log("   p0 / spot:", p0, spot);
            ++n;

            vm.revertToState(snap);
        }

        console2.log("raises swept              ", n);
        console2.log("launch blocks that OPENED ", unlockedCount);
        console2.log("launch blocks that LOCKED ", n - unlockedCount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE J — the self-referral guard is one EOA deep
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  `_recordReferral` refused `referrer == user` and the
    // natspec claimed this stopped "anyone farming their own 10 %".  A second
    // address the same person controls is not `user`, so the 10 % came straight
    // back — to a wallet with no quota, no deposit and no history.
    //
    // FIX 1.  A referrer must hold PoG quota, which puts a throwaway wallet
    // behind the same oracle attestation a depositor needs.  Not a wall; a per
    // sybil cost the signer can price off-chain.
    //
    // FIX 2 (two-slot referrals).  Binding per project would have made this
    // attack N times better at no extra cost — the same throwaway collecting on
    // every project instead of once per wallet, lifetime.  So the 8 % project
    // leg additionally requires the referrer to hold a deposit IN THAT PROJECT,
    // and only the 2 % lifetime leg is reachable without one.
    //
    // What that leaves, measured below: an attested but unstaked throwaway
    // recovers 2 % rather than 10 %, and recovering the full 10 % costs a stake
    // in every project it wants to farm.  The throwaway's stake is not burned —
    // it earns genesis tokens like any other deposit — so this is capital tied
    // up, not capital lost.  Still a price, still not a wall.
    function test_probeJ_referralSelfFarmViaSecondWallet() public {
        address sybil = makeAddr("sybil"); // attacker's own second EOA, never attested

        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address h) = factory.createLaunch{value: fee}("Farm", "FRM", projTreasury, projTreasury, salt, fee, 24 hours);
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(h));

        _registerPoG(attacker, POG_CAP);
        vm.prank(attacker);
        factory.deposit{value: 10 ether}(address(hook), sybil);

        // The deposit still succeeds — a rejected binding must never brick one.
        assertEq(hook.ethDeposited(attacker), 10 ether, "deposit is unaffected");
        assertEq(factory.globalReferrers(attacker), address(0), "unattested referrer does not bind");
        assertEq(hook.referralAccrued(sybil), 0, "and accrues nothing");
        assertEq(hook.orphanReferral(), 1 ether, "the 10 % falls through to buyback fuel");

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();

        vm.prank(sybil);
        vm.expectRevert(ToshLaunchpadHook.NoReferralReward.selector);
        hook.claimReferralReward();

        // An ATTESTED referrer is still paid — the programme itself still works.
        address realRef = makeAddr("realReferrer");
        _registerPoG(realRef, POG_CAP);
        _registerPoG(alice, POG_CAP);

        bytes32 salt2 = _mineSalt();
        vm.prank(creator);
        (, address h2) =
            factory.createLaunch{value: fee}("Farm2", "FR2", projTreasury, projTreasury, salt2, fee, 24 hours);
        ToshLaunchpadHook hook2 = ToshLaunchpadHook(payable(h2));

        vm.prank(alice);
        factory.deposit{value: 10 ether}(address(hook2), realRef);
        assertEq(hook2.referralAccrued(realRef), 0.2 ether, "an attested but unstaked referrer earns the 2 % leg");
        assertEq(hook2.orphanReferral(), 0.8 ether, "the 8 % project leg orphans for want of a stake");

        // The whole 10 % is still reachable — it just costs a stake in this
        // project, which is the gate's entire purpose. `realRef` stakes hook2,
        // and the next referee to arrive on their link pays both legs.
        address referee2 = makeAddr("referee2");
        vm.deal(realRef, 10 ether);
        vm.deal(referee2, 100 ether);

        vm.prank(realRef);
        factory.deposit{value: 1 ether}(address(hook2), address(0));

        _registerPoG(referee2, POG_CAP);
        vm.prank(referee2);
        factory.deposit{value: 10 ether}(address(hook2), realRef);

        assertEq(
            hook2.referralAccrued(realRef),
            1.2 ether,
            "0.2 from alice's lifetime leg, then 0.8 + 0.2 from a referee who arrived after the stake"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE K — setMaxPogAllocationLimit(0) bricks createLaunch entirely
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The dial is snapshotted into the hook's constructor,
    // which does `require(_perWalletCap > 0)`, so at 0 the CREATE2 construction
    // reverted and `createLaunch` died with `DeployFailed` for every creator —
    // from a setter documented as governing "new projects only".
    //
    // FIX.  The setter refuses zero outright, so the failure surfaces at the
    // governance call instead of at every creator's transaction.
    function test_probeK_zeroPogLimitBricksCreateLaunch() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.InvalidPogLimit.selector);
        factory.setMaxPogAllocationLimit(0);

        assertEq(factory.maxPogAllocationLimit(), POG_CAP, "dial is unchanged");

        // 1 wei is still accepted: this is a zero guard, not a policy floor.
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(1);
        assertEq(factory.maxPogAllocationLimit(), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE L — who does the "one-way valve" actually pay?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The treasury cannot send ETH anywhere but into a buy
    // whose output burns — but the OWNER alone decides WHICH market absorbs it,
    // and `removeLadderToken` narrows the list to one.  `perToken` was
    // `spend / count`, so a one-token ladder pointed the FULL 10 % cheque at a
    // single pool, and any address can fire the poke with a dust swap.
    //
    // FIX.  `perToken` is now `spend / BATCH_SIZE`, so a narrow list buys a
    // narrow trickle instead of the same cheque concentrated.  The sqrt floor
    // already rate-limited the drain per window; this removes the concentration
    // bonus for narrowing the list at all.
    function test_probeL_ownerDirectsEntireReservoirAtOneMarket() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);
        _nextBlock();
        _buy(hook, alice, 1 ether);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));

        vm.deal(address(ladder), 100 ether);

        uint256 poolEthBefore = address(poolManager).balance;
        uint256 burnedBefore = token.balanceOf(DEAD);

        // Anybody can fire the poke.  One dust swap per poke, all in one block.
        uint256 pokes;
        while (address(ladder).balance >= 1 ether && pokes < 60) {
            _buy(hook, attacker, 1000);
            ++pokes;
        }

        console2.log("pokes fired                  ", pokes);
        console2.log("reservoir left               ", address(ladder).balance);
        console2.log("ETH pushed into the one pool ", address(poolManager).balance - poolEthBefore);
        console2.log("tokens burned                ", token.balanceOf(DEAD) - burnedBefore);
        (,,, uint256 spot,,,) = hook.tierStatus();
        console2.log("spot after the forced buying ", spot);

        // Unlimited pokes still cannot empty the reservoir into the chosen pool.
        //
        // Be precise about WHICH guard is doing the work here: at this pool
        // depth it is `_buybackSqrtFloor`, which refuses to walk the pool more
        // than ~10 % in sqrt terms above its TWAP, so once the first few legs
        // have moved the price the rest of the pokes fill nothing until the
        // window rolls.  Dividing `perToken` by BATCH_SIZE sits behind that as
        // defence in depth — it shrinks the cheque a narrow list is handed, and
        // it is what bites in a pool deep enough for the floor not to.
        assertGt(address(ladder).balance, 85 ether, "a one-token ladder cannot be drained on demand");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE D — can the 1.0 % in-flight tax be rounded away with dust swaps?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `tax = input * 100 / 10_000` floors, and `beforeSwap` returns early when it
    // lands on zero.  Any input below 100 wei therefore trades untaxed.
    //
    // The band NARROWED when the rate went 70 → 100 bps: it used to run to
    // 142 wei, and a higher rate reaches its first whole wei of tax sooner.
    // Raising a rate cannot widen a floor-division dead zone, so this direction
    // is the only one available — but it is worth pinning rather than assuming,
    // because the split introduced a SECOND, wider boundary above it.
    function test_probeD_dustSwapEvadesTax() public {
        (, ToshLaunchpadHook hook) = _launchProject(10 ether);
        _nextBlock();

        uint256 treasuryBefore = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;

        // 99 wei * 100 / 10_000 == 0
        for (uint256 i; i < 20; ++i) {
            _buy(hook, attacker, 99);
        }

        console2.log("treasury delta after 20 dust buys", address(ladder).balance - treasuryBefore);
        console2.log("tax on 99 wei ", uint256(99 * 100) / 10_000);
        console2.log("tax on 100 wei", uint256(100 * 100) / 10_000);

        // ACCEPTED, NOT FIXED.  The evasion is real and it is worthless: to move
        // 1 ETH untaxed you would need ~1e16 swaps of 99 wei, each paying full
        // calldata and pool-accounting gas, to avoid 0.01 ETH of tax.  The
        // rounding runs in the trader's favour by one wei-scale unit, which is
        // the same direction every other rounding in this codebase runs.
        //
        // What is worth pinning is the THRESHOLD, so a future change to TAX_BPS
        // or to the early-return cannot silently widen the untaxed band.
        assertEq(uint256(99 * 100) / 10_000, 0, "99 wei is the largest untaxed input");
        assertEq(uint256(100 * 100) / 10_000, 1, "100 wei is the smallest taxed one");
        assertEq(address(ladder).balance, treasuryBefore, "so 20 dust buys yield the treasury nothing");
        assertEq(platformTreasury.balance, platformBefore, "and the platform nothing either");
    }

    // ── PROBE D, second boundary: the platform cut's own floor ────────────────
    //
    // The buy leg now splits its skim, and the platform's 30 bps floors to zero
    // over a band THREE TIMES WIDER than the one above: `input * 30 / 10_000` is
    // 0 for every input below 334 wei, while `tax` itself is already non-zero
    // from 100 wei up.  Between those two figures the swap IS taxed and the
    // platform is paid nothing.
    //
    // That gap is not a leak, and the point of this probe is to show why.  The
    // reservoir's share is computed as `tax - platformCut`, not as its own
    // multiplication, so every wei the platform's floor division drops stays
    // inside the credit the hook already claimed and is `take`n to the buyback
    // instead.  Conservation is what the pool's solvency depends on — both call
    // sites hand V4 a hook delta of exactly `tax`, so a split that summed to
    // less would revert `CurrencyNotSettled` and a split that summed to more
    // would draw currency the hook was never credited.
    //
    // So there is nothing to evade here: shrinking your trade below 334 wei
    // does not reduce what you pay, it only redirects the platform's third of
    // it into the buyback.  Which is the strictly worse outcome for anyone
    // trying to game it, and the reason the dust bias was pointed this way.
    function test_probeD_platformCutFloorsToZeroBelowThreeThirtyFour() public {
        (, ToshLaunchpadHook hook) = _launchProject(10 ether);
        _nextBlock();

        // The documented worked example: 110 wei is taxed one wei, and that
        // whole wei goes to the reservoir because 110 * 30 / 10_000 floors to 0.
        // A naive `110 * 70 / 10_000` would also floor to 0 — the pair would
        // settle nothing against a credit of 1, and the swap would revert.
        assertEq(uint256(110 * 100) / 10_000, 1, "110 wei owes one wei of tax");
        assertEq(uint256(110 * 30) / 10_000, 0, "which the platform's rate cannot see");
        assertEq(uint256(110 * 70) / 10_000, 0, "and neither could a naive reservoir rate");

        _assertBuySplitConserves(hook, 110, 1, 0);

        // Walk the platform boundary itself.  333 wei: tax 3, platform 0.
        // 334 wei: tax 3, platform 1.  Neither reverts.
        assertEq(uint256(333 * 30) / 10_000, 0, "333 wei is the largest input the platform sees nothing from");
        assertEq(uint256(334 * 30) / 10_000, 1, "334 wei is the smallest it does");

        _assertBuySplitConserves(hook, 333, 3, 0);
        _assertBuySplitConserves(hook, 334, 3, 1);

        // And nothing in the whole band from the first taxed wei to well past
        // the platform boundary reverts or mis-settles.
        for (uint256 input = 100; input <= 400; ++input) {
            uint256 tax = (input * 100) / 10_000;
            uint256 expectedPlatform = (input * 30) / 10_000;
            _assertBuySplitConserves(hook, input, tax, expectedPlatform);
        }
    }

    /// @dev Execute one dust buy and assert the split both conserves `tax` and
    ///      lands the expected amount on each side.
    function _assertBuySplitConserves(
        ToshLaunchpadHook hook,
        uint256 input,
        uint256 expectedTax,
        uint256 expectedPlatform
    ) internal {
        uint256 ladderBefore = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;

        _buy(hook, attacker, input);

        uint256 reservoirCut = address(ladder).balance - ladderBefore;
        uint256 platformCut = platformTreasury.balance - platformBefore;

        assertEq(platformCut, expectedPlatform, "platform cut at this input");
        assertEq(reservoirCut, expectedTax - expectedPlatform, "reservoir takes the remainder, dust included");
        assertEq(reservoirCut + platformCut, expectedTax, "the two cuts must sum to the credited tax");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE E — shelf-mint rounding: how many tokens per wei of underpayment?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `legCost = tierPrice * take / 1e18` floors in the buyer's favour.  Measure
    // the largest order that costs exactly 1 wei.
    function test_probeE_mintRoundingEdge() public {
        (, ToshLaunchpadHook hook) = _launchProject(10 ether);
        _nextBlock();

        uint256 price = hook.tierPriceAt(0);
        console2.log("tierPriceAt(0) wei/token", price);

        // Largest `take` with (price * take) / 1e18 == 1.
        uint256 take = (2 * 1e18) / price - 1;
        uint256 cost = (price * take) / 1e18;
        console2.log("take (wei-tokens)", take);
        console2.log("cost (wei)       ", cost);

        vm.prank(attacker);
        uint256 charged = hook.mintBondingCurve{value: cost}(take);
        assertEq(charged, cost, "charged == quoted");
        console2.log("tokens bought for 1 wei", take);
        console2.log("full ladder at this rate needs N txs", 12_600_000e18 / take);

        // ACCEPTED, NOT FIXED.  One wei buys ~0.0000000000008 of a token here,
        // and the ladder cannot be walked this way: `mintBondingCurve` advances
        // the cursor by exactly what it sells, so draining 12.6 M at this
        // granularity needs the transaction count logged above — a number with
        // no physical meaning.  Rounding in the buyer's favour by one wei-unit
        // per leg is the deliberate direction; the alternative (ceil) would let
        // a quote come back below what the mint then charges.
        //
        // The invariant that actually matters is that nothing is EVER free.
        assertGt(cost, 0, "a positive request always costs at least 1 wei");
        assertEq(hook.phase2Minted(), take, "and the cursor advances by exactly what was sold");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE F — can a dumper freeze the ladder (deny project revenue)?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The reference is `min(spot, TWAP)` with LIVE spot.  A dump crashes spot
    // instantly, and spot only recovers when somebody arbitrages it back.
    function test_probeF_spotCrashFreezesLadder() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(100 ether);

        // Let the market rally so a good chunk of ladder is unlocked.
        _nextBlock();
        _buy(hook, alice, 300 ether);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        uint256 unlockedAfterRally = hook.maxMintable();
        console2.log("maxMintable after rally", unlockedAfterRally);
        assertGt(unlockedAfterRally, 0, "fixture needs an open ladder to then freeze");

        // Attacker dumps whatever they hold to crash spot.
        uint256 bal = token.balanceOf(alice);
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(alice);
        token.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(bal), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        _nextBlock();
        (,,, uint256 spot, uint256 twap,,) = hook.tierStatus();
        console2.log("spot after dump ", spot);
        console2.log("twap after dump ", twap);
        console2.log("maxMintable now ", hook.maxMintable());

        // ACCEPTED, NOT FIXED — and this is the gate working, not failing.
        //
        // The reference is `min(spot, TWAP)` with LIVE spot precisely so that a
        // collapsing market shuts the ladder instantly rather than a window
        // later.  The mirror image is that anyone willing to sell into their own
        // dump can throttle project revenue for as long as they can hold the
        // price down — which costs them the spread every time, and ends the
        // moment an arbitrageur takes the other side.
        //
        // Using max() instead would make the ladder unfreezable and also make it
        // mintable straight into a crash.  That is the worse trade.
        assertLt(hook.maxMintable(), unlockedAfterRally, "a crashed spot must throttle the ladder");
        assertLe(spot, twap, "spot leads the TWAP down, so min() follows spot");
    }
}
