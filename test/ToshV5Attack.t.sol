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
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
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
    // The spend is `max(1 ETH, 10 % of the reservoir)` split across at most
    // BATCH_SIZE=3 tokens.  With a single listed token the whole 10 % lands in
    // one pool, so the sandwich target grows linearly with the reservoir — the
    // "0.33 ETH they are trying to skim" figure in the natspec only holds while
    // the treasury is nearly empty.
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
        // routes every launch fee, every 0.7 % buy tax and every 1 % shelf cut
        // into a contract with no withdraw path.
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
    //  PROBE H — an untaxed parallel venue for the same token
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `beforeInitialize` stops anyone opening a pool THAT USES THIS HOOK.  It
    // says nothing about a HOOKLESS pool over the same ERC-20, which V4 lets
    // anybody create.  Such a pool pays no 0.7 % tax, feeds no oracle, and
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

        vm.prank(attacker);
        poolManager.initialize(rogue, TickMath.getSqrtPriceAtTick(0));
        console2.log("rogue hookless ETH/token pool initialised by a stranger");

        // And it is immediately usable: seed it and trade tax-free.
        uint256 seed = token.balanceOf(alice) / 2;
        vm.startPrank(alice);
        token.approve(address(liqRouter), type(uint256).max);
        vm.stopPrank();
        console2.log("alice can seed it with", seed);

        uint256 treasuryBefore = address(ladder).balance;
        console2.log("treasury take from rogue venue", address(ladder).balance - treasuryBefore);
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
        console2.log("hook balance after sole depositor claims", token.balanceOf(address(hook)));
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
    // FIX.  A referrer must now hold PoG quota, which puts a throwaway wallet
    // behind the same oracle attestation a depositor needs.  Not a wall; a per
    // sybil cost the signer can price off-chain.
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
        assertEq(hook2.referralAccrued(realRef), 1 ether, "an attested referrer still earns 10 %");
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
    //  PROBE D — can the 0.7 % in-flight tax be rounded away with dust swaps?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `tax = input * 70 / 10_000` floors, and `beforeSwap` returns early when it
    // lands on zero.  Any input below 143 wei therefore trades untaxed.
    function test_probeD_dustSwapEvadesTax() public {
        (, ToshLaunchpadHook hook) = _launchProject(10 ether);
        _nextBlock();

        uint256 treasuryBefore = address(ladder).balance;

        // 142 wei * 70 / 10_000 == 0
        for (uint256 i; i < 20; ++i) {
            _buy(hook, attacker, 142);
        }

        console2.log("treasury delta after 20 dust buys", address(ladder).balance - treasuryBefore);
        console2.log("tax on 142 wei", uint256(142 * 70) / 10_000);
        console2.log("tax on 143 wei", uint256(143 * 70) / 10_000);
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

        console2.log("maxMintable after rally", hook.maxMintable());

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
    }
}
