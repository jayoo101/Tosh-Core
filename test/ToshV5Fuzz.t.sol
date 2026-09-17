// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";

/// @notice v5.0 property tests: monotone tier prices, genesis pro-rata, PoG
///         window accounting, and quoteMint never quoting a free mint.
contract ToshV5FuzzTest is Test {
    using MessageHashUtils for bytes32;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xF1F1;
    address internal pogSigner;

    Vault internal vault;

    CLPoolManager internal poolManager;
    CLPoolManagerRouter internal router;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;
    address internal trader = makeAddr("trader");

    uint256 internal constant SOFT_CAP = 1 ether;
    uint256 internal constant POG_CAP = 10 ether;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);
        // Vault first, and the manager registered with it before it may move any
        // balance. See test/ToshV5.t.sol for the full argument.
        vault = new Vault();
        poolManager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(poolManager));
        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), address(vault), admin);
        factory = new ToshFactory(address(poolManager), address(vault), pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));
        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(trader, 1000 ether);
    }

    /// @dev Unlock the shelf ladder.  Shelf 0 is anchored at `1.05 x p0` and
    ///      the gate caps shelves at `1.05 x min(spot, TWAP)`, so the ladder
    ///      opens shut and only lifts once the market holds at or above the
    ///      genesis price.  Buy the pool up, then age the move into the TWAP.
    function _openLadder(ToshLaunchpadHook hook, uint256 nativeIn) internal {
        _swapBuy(hook, nativeIn);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, 1e14);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Infinity names these the opposite of V4 and means the opposite by
    ///      them: V4 took `{takeClaims: false, settleUsingBurn: false}` where
    ///      this takes `{withdrawTokens: true, settleUsingTransfer: true}`. Both
    ///      say the same thing — hand over real tokens, settle by transferring
    ///      them. Copying the old `false, false` across would have left every
    ///      swap settling through claim tokens this suite never mints. Reasoned
    ///      out once in test/ToshV5.t.sol.
    function _swapSettings() internal pure returns (CLPoolManagerRouter.SwapTestSettings memory) {
        return CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true});
    }

    function _swapBuy(ToshLaunchpadHook hook, uint256 nativeIn) internal {
        vm.prank(trader);
        router.swap{value: nativeIn}(
            hook.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
    }

    function _pickSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookAddress.computeAddress(address(factory), finalSalt, initHash);
            if (predicted.code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _createProject() internal returns (ToshToken token, ToshLaunchpadHook hook) {
        return _createProject("Fuzz", "FZZ");
    }

    /// @dev Named variant: `(name, symbol)` is claimed globally, so a test that
    ///      needs two live projects has to give them distinct identities.
    function _createProject(string memory name, string memory symbol)
        internal
        returns (ToshToken token, ToshLaunchpadHook hook)
    {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address t, address h) = factory.createLaunch{value: fee}(
            name, symbol, projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));
    }

    function _register(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);
        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    function _deposit(address user, ToshLaunchpadHook hook, uint256 amount) internal {
        if (factory.pogQuota(user) == 0) _register(user, POG_CAP);
        vm.deal(user, user.balance + amount);
        vm.prank(user);
        factory.deposit{value: amount}(address(hook), address(0));
    }

    function _launch(ToshLaunchpadHook hook) internal {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    /// @dev Shelf pricing reads `shelfP0`, not `p0`, so that is the slot the
    ///      monotonicity property has to drive.
    function _shelfP0Slot(ToshLaunchpadHook h) internal returns (uint256 slot) {
        bytes32 probe = bytes32(uint256(987_654_321e9));
        for (uint256 i; i < 64; ++i) {
            bytes32 prev = vm.load(address(h), bytes32(i));
            vm.store(address(h), bytes32(i), probe);
            if (h.shelfP0() == uint256(probe)) {
                vm.store(address(h), bytes32(i), prev);
                return i;
            }
            vm.store(address(h), bytes32(i), prev);
        }
        revert("shelfP0 slot not found");
    }

    /// @dev Closed-form shelf prices are strictly increasing once the ladder
    ///      base is positive.
    function testFuzz_tierPriceAt_strictlyMonotone(uint256 idx, uint256 baseRaw) public {
        idx = bound(idx, 0, 3998);
        uint256 base = bound(baseRaw, 1e6, 1e22);

        // The shelf-price curve is a closed form over `shelfP0` and constants —
        // it reads no per-project immutable arg — so a bare implementation is a
        // sufficient host for poking the base value into storage.
        ToshLaunchpadHook h = new ToshLaunchpadHook(
            address(poolManager), address(vault), address(factory), payable(address(ladder)), platformTreasury
        );
        vm.store(address(h), bytes32(_shelfP0Slot(h)), bytes32(base));

        uint256 a = h.tierPriceAt(idx);
        uint256 b = h.tierPriceAt(idx + 1);
        assertGt(a, 0, "shelf price must be positive once the base is positive");
        assertGt(b, a, "next shelf must cost strictly more");
        assertEq(h.tierPriceAt(h.TIER_COUNT()), 0);
    }

    /// @dev The step from `shelfP0` to shelf 1, in wei, at a poked base.
    function _firstStepAt(ToshLaunchpadHook h, uint256 base) internal returns (uint256) {
        vm.store(address(h), bytes32(_shelfP0Slot(h)), bytes32(base));
        // Non-decreasing by construction, so this cannot underflow; zero is
        // exactly the failure this measures.
        return h.tierPriceAt(1) - h.tierPriceAt(0);
    }

    /// @notice Monotonicity has a break-even, and THREE constants decide whether
    ///         the system can reach it.
    ///
    /// @dev    The fuzz above bounds the base at a hardcoded `1e6`, which is a
    ///         number about the fuzzer rather than about this system — nothing
    ///         ties it to what the constants permit. `MIN_SOFT_CAP_PROD`,
    ///         `GENESIS_LP_SUPPLY` and `SHELF_PREMIUM_BPS` between them fix the
    ///         smallest `shelfP0` a real launch can produce, and any of the three
    ///         can be retuned on its own. Two adjacent shelves sharing a price
    ///         would let a buyer clear the upper one at the lower one's price, so
    ///         the chain from those constants down to "the ladder still steps"
    ///         is worth one assertion.
    ///
    ///         The break-even is pinned as a measurement, not a literal belief:
    ///         `STEP` is 1.0019025, so a base of 525 wei steps by
    ///         `floor(525 · 1.0019025) − 525 = 0`, and 526 is the first base that
    ///         moves at all. Both directions are asserted, because a test that
    ///         only shows the healthy side cannot tell a real margin from an
    ///         arithmetic accident.
    function test_smallestReachableShelfP0_stillStepsTheLadder() public {
        ToshLaunchpadHook h = new ToshLaunchpadHook(
            address(poolManager), address(vault), address(factory), payable(address(ladder)), platformTreasury
        );

        assertEq(_firstStepAt(h, 525), 0, "525 is below the break-even: shelves 0 and 1 share a price");
        assertEq(_firstStepAt(h, 526), 1, "526 is the break-even: the ladder steps by one wei");

        // Smallest raise `launch()` accepts, and the least of it that can reach
        // the LP — the referral carve takes at most `REFERRAL_BPS`.
        uint256 minRaise = factory.MIN_SOFT_CAP_PROD();
        uint256 minLpEth = minRaise - (minRaise * h.REFERRAL_BPS()) / 10_000;
        uint256 minShelfP0 = (((minLpEth * 1e18) / h.GENESIS_LP_SUPPLY()) * h.SHELF_PREMIUM_BPS()) / 10_000;

        // 0.01 ETH → p0 2,380,952,380 → shelfP0 2,499,999,999. The factory
        // natspec quotes the middle figure as "2.38e9"; this is the one shelf
        // pricing actually reads. Note it is a wei under 2.5e9 and not exactly
        // `p0 · 1.05` — both divisions floor, so even here the arithmetic gives
        // the wei to the buyer.
        assertEq(minShelfP0, 8_749_999_999, "smallest reachable ladder base");

        assertGe(
            minShelfP0 / 526,
            4_000_000,
            "the reachable minimum must sit millions of times above the break-even, not just above it"
        );
        assertEq(_firstStepAt(h, minShelfP0), 16_646_947, "step at the reachable minimum");
    }

    /// @dev Pro-rata genesis claims never overshoot GENESIS_CLAIM_SUPPLY.
    function testFuzz_claimGenesis_proRataNeverExceedsClaimSupply(uint256 d1, uint256 d2) public {
        d1 = bound(d1, 1, 0.4 ether);
        d2 = bound(d2, 1, 0.4 ether);

        (, ToshLaunchpadHook hook) = _createProject();
        ToshToken token = ToshToken(address(hook.projectToken()));

        address u1 = makeAddr("fuzzU1");
        address u2 = makeAddr("fuzzU2");
        _deposit(u1, hook, d1);
        _deposit(u2, hook, d2);

        uint256 raised = hook.totalNativeDeposited();
        if (raised < SOFT_CAP) {
            _deposit(makeAddr("fuzzWhale"), hook, SOFT_CAP - raised);
        }

        _launch(hook);

        uint256 total = hook.totalNativeDeposited();
        uint256 supply = hook.GENESIS_CLAIM_SUPPLY();
        uint256 expected1 = (supply * d1) / total;
        uint256 expected2 = (supply * d2) / total;

        vm.prank(u1);
        hook.claimGenesis();
        assertEq(token.balanceOf(u1), expected1);
        assertLe(expected1, supply);

        vm.prank(u2);
        hook.claimGenesis();
        assertEq(token.balanceOf(u2), expected2);
        assertLe(expected1 + expected2, supply);
    }

    /// @dev With quotaWindowDuration == 0 the PoG budget is lifetime, not a window.
    function testFuzz_pogQuota_globalAcrossDeposits(uint96 quota, uint96 deposit1, uint96 deposit2) public {
        uint256 q = bound(uint256(quota), 1e15, factory.maxPogAllocationLimit());
        uint256 d1 = bound(uint256(deposit1), 1, q);
        uint256 d2 = bound(uint256(deposit2), 1, q);

        (, ToshLaunchpadHook hook) = _createProject();
        address fuzzUser = makeAddr("fuzzPogUser");
        // Fund both legs up front: a tight `q + 1 ether` budget is not enough
        // when `d1 ≈q` and the revert path still has to attach `d2` as value.
        vm.deal(fuzzUser, 2 * q + 1 ether);
        _register(fuzzUser, q);

        vm.startPrank(fuzzUser);
        factory.deposit{value: d1}(address(hook), address(0));
        assertEq(factory.totalGenesisDeposited(fuzzUser), d1);

        if (d1 + d2 > q) {
            vm.expectRevert(ToshFactory.QuotaExceeded.selector);
            factory.deposit{value: d2}(address(hook), address(0));
        } else {
            factory.deposit{value: d2}(address(hook), address(0));
            assertEq(factory.totalGenesisDeposited(fuzzUser), d1 + d2);
        }
        vm.stopPrank();
    }

    /// @dev A positive token request never quotes a free (zero-cost) mint.
    function testFuzz_quoteMint_noFreeMintForPositiveRequest(uint256 tokens) public {
        (, ToshLaunchpadHook hook) = _createProject();
        _deposit(makeAddr("funder"), hook, SOFT_CAP);
        _launch(hook);
        _openLadder(hook, 0.01 ether);

        tokens = bound(tokens, 1, hook.TIER_SIZE());

        try hook.quoteMint(tokens) returns (uint256 cost) {
            assertGt(cost, 0, "positive tokens must cost positive ETH");
        } catch (bytes memory err) {
            bytes4 selector = bytes4(err);
            assertEq(selector, ToshLaunchpadHook.ZeroAmount.selector, "unexpected revert selector");
        }
    }

    /// @dev `quoteMint` and `mintBondingCurve` run two hand-copied per-leg
    ///      loops.  This pins them together across every span the gate allows,
    ///      so a future edit to one that is not mirrored in the other fails CI
    ///      rather than silently overcharging buyers.
    function testFuzz_QuoteMatchesMintAcrossSpans(uint256 tokens) public {
        (, ToshLaunchpadHook hook) = _createProject();
        _deposit(makeAddr("funder"), hook, SOFT_CAP);
        _launch(hook);
        _openLadder(hook, 0.01 ether);

        uint256 cap = hook.maxMintable();
        assertGt(cap, hook.TIER_SIZE(), "the fuzz range must be able to straddle shelves");
        // Floor at one whole token: sub-wei-cost orders trip the L-01 dust
        // guard, which is its own test.
        tokens = bound(tokens, 1e18, cap);

        uint256 quoted = hook.quoteMint(tokens);

        address buyer = makeAddr("spanBuyer");
        vm.deal(buyer, 100 ether);
        vm.prank(buyer);
        uint256 charged = hook.mintBondingCurve{value: 100 ether}(tokens);

        assertEq(charged, quoted, "the quote must be exactly what the mint charges");
        assertEq(buyer.balance, 100 ether - quoted, "everything above the quote is refunded");
    }

    /// @dev Sweeping a span costs exactly what the same order costs when chopped
    ///      shelf by shelf —the fill is a pure accounting change, not a repricing.
    function testFuzz_SpanCostEqualsChoppedCost(uint256 tokens) public {
        (, ToshLaunchpadHook swept) = _createProject("SweptFuzz", "SWF");
        _deposit(makeAddr("funderA"), swept, SOFT_CAP);
        _launch(swept);
        _openLadder(swept, 0.01 ether);

        (, ToshLaunchpadHook chopped) = _createProject("ChoppedFuzz", "CHF");
        _deposit(makeAddr("funderB"), chopped, SOFT_CAP);
        _launch(chopped);
        _openLadder(chopped, 0.01 ether);

        assertEq(swept.shelfP0(), chopped.shelfP0(), "twins must open at the same price");

        // Whole tokens only, and the rounding is load-bearing rather than
        // tidiness.  Chopping walks shelf boundaries and mints whatever is left
        // over last, so a span of `n * 1e18 + 1` ends on a one-wei-of-token
        // order whose cost floors to zero — which the L-01 dust guard rejects,
        // as it should.  The whole span still costs something, so the sweep goes
        // through and the two sides cannot be compared at all.
        //
        // That is the decomposition being undefined on those inputs, not the
        // prices disagreeing, so the domain is narrowed instead of the guard
        // being worked around.  `TIER_SIZE` is a whole-token multiple, so every
        // chunk this loop produces is one too. Dust orders have their own test.
        tokens = (bound(tokens, 1e18, swept.maxMintable()) / 1e18) * 1e18;

        address buyer = makeAddr("spanBuyer");
        vm.deal(buyer, 200 ether);

        vm.prank(buyer);
        uint256 sweptCost = swept.mintBondingCurve{value: 50 ether}(tokens);

        uint256 choppedCost;
        uint256 left = tokens;
        vm.startPrank(buyer);
        while (left > 0) {
            uint256 take = chopped.TIER_SIZE() - chopped.currentTierSold();
            if (take > left) take = left;
            choppedCost += chopped.mintBondingCurve{value: 50 ether}(take);
            left -= take;
        }
        vm.stopPrank();

        assertEq(sweptCost, choppedCost);
        assertEq(swept.currentTierIndex(), chopped.currentTierIndex());
        assertEq(swept.currentTierSold(), chopped.currentTierSold());

        // All three share one storage word, and this is the call that moves all
        // three at once — the shelf advances, the per-shelf counter resets, and
        // the running total grows. So it is also the natural place to catch one
        // packed field bleeding into another.
        assertEq(swept.phase2Minted(), tokens, "the swept side must count every token it issued");
        assertEq(chopped.phase2Minted(), tokens, "and the chopped side the same total");
    }
}
