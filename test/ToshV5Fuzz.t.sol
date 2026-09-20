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
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";

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

    /// @dev Stands in for BEM, at eight decimals.
    MockQuoteAsset internal quote;
    address internal trader = makeAddr("trader");

    uint256 internal constant SOFT_CAP = 100e8;
    uint256 internal constant POG_CAP = 1000e8;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);
        // Vault first, and the manager registered with it before it may move any
        // balance. See test/ToshV5.t.sol for the full argument.
        vault = new Vault();
        poolManager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(poolManager));
        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));

        quote = new MockQuoteAsset();

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote));
        factory = new ToshFactory(
            address(poolManager), address(vault), pogSigner, platformTreasury, address(ladder), address(quote)
        );
        ladder.setFactory(address(factory));
        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        // Native for gas only.
        vm.deal(creator, 100 ether);
        vm.deal(trader, 1000 ether);

        _endow(creator);
        _endow(trader);
    }

    /// @dev Mint a quote balance and approve the factory and the router. A fuzz
    ///      suite gets an unlimited allowance deliberately: a bounded one is a
    ///      second resource a run can exhaust, and "the property held because the
    ///      approval ran out" is not a property.
    function _endow(address who) internal {
        quote.mint(who, 1_000_000e8);
        vm.startPrank(who);
        quote.approve(address(factory), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Unlock the shelf ladder.  Shelf 0 is anchored at `1.05 x p0` and
    ///      the gate caps shelves at `1.05 x min(spot, TWAP)`, so the ladder
    ///      opens shut and only lifts once the market holds at or above the
    ///      genesis price.  Buy the pool up, then age the move into the TWAP.
    function _openLadder(ToshLaunchpadHook hook, uint256 nativeIn) internal {
        _swapBuy(hook, nativeIn);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, 1e6);
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
        // Read before the prank: an argument that is itself an external call
        // is evaluated first and would consume it. See _swapBuy.
        PoolKey memory key = hook.getPoolKey();
        vm.prank(trader);
        router.swap(
            key,
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
        // Mint exactly what this deposit needs on top of whatever `user` holds,
        // and approve the factory. A fuzzed `amount` can exceed any fixed
        // endowment, so the funding has to follow the value rather than precede
        // it — which is what `vm.deal(user, user.balance + amount)` did.
        quote.mint(user, amount);
        vm.prank(user);
        quote.approve(address(factory), type(uint256).max);
        vm.prank(user);
        factory.deposit(address(hook), address(0), amount);
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
            address(poolManager),
            address(vault),
            address(factory),
            payable(address(ladder)),
            platformTreasury,
            address(quote)
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
            address(poolManager),
            address(vault),
            address(factory),
            payable(address(ladder)),
            platformTreasury,
            address(quote)
        );

        assertEq(_firstStepAt(h, 525), 0, "525 is below the break-even: shelves 0 and 1 share a price");
        assertEq(_firstStepAt(h, 526), 1, "526 is the break-even: the ladder steps by one wei");

        // Smallest raise `launch()` accepts, and the least of it that can reach
        // the LP — the referral carve takes at most `REFERRAL_BPS`.
        uint256 minRaise = factory.MIN_SOFT_CAP_PROD();
        uint256 minLpQuote = minRaise - (minRaise * h.REFERRAL_BPS()) / 10_000;
        uint256 minShelfP0 = (((minLpQuote * 1e18) / h.GENESIS_LP_SUPPLY()) * h.SHELF_PREMIUM_BPS()) / 10_000;

        // 100 BEM raised → 90 BEM to the LP → p0 = 9e9 × 1e18 / 3.78e24 = 2380 →
        // shelfP0 = 2380 × 1.05 = 2499. Both divisions floor, so the base lands a
        // unit under `p0 × 1.05`: the arithmetic gives the remainder to the buyer.
        assertEq(minShelfP0, 2499, "smallest reachable ladder base");

        // ⚠ THIS MARGIN COLLAPSED BY SIX ORDERS OF MAGNITUDE WHEN THE QUOTE ASSET
        //   MOVED TO BEM, and it is the single most consequential number in that
        //   decision.
        //
        //   The assertion here used to be `>= 4_000_000`. At 18 decimals the
        //   smallest legal raise produced a shelf base sixteen million times the
        //   break-even, so `MIN_SOFT_CAP_PROD` was a formality — no plausible
        //   retune of the three constants could have brought the ladder near
        //   degenerating. BEM has EIGHT decimals. The same chain now yields 2499
        //   against a break-even of 526: a factor of 4.75.
        //
        //   What that changes: `MIN_SOFT_CAP_PROD` is now load-bearing. Below
        //   roughly 21 BEM the base falls under 526 and two adjacent shelves round
        //   onto one price, which lets a buyer clear the upper shelf at the lower
        //   shelf's price. `docs/BEM_QUOTE_ASSET.md` §2.2 argued the 108x raise in
        //   the floor; this is the assertion holding that argument to its
        //   arithmetic, and `test_belowTheSoftCapFloor_theLadderStopsStepping`
        //   below is the other half.
        //
        //   Written as a floor of 4 rather than `== 4` so a retune that WIDENS the
        //   margin passes and only a narrowing one fails.
        assertGe(minShelfP0 / 526, 4, "the reachable minimum must still clear the break-even with room");
        assertLt(
            minShelfP0 / 526,
            100,
            "if this ever passes 100 again the quote asset's decimals changed -- re-read the note above"
        );

        assertEq(_firstStepAt(h, minShelfP0), 4, "step at the reachable minimum");
    }

    /// @notice Just below `MIN_SOFT_CAP_PROD` the ladder stops stepping, and the
    ///         factory refuses to be configured there.
    ///
    /// @dev    The test above measures the margin AT the floor. This measures what
    ///         is on the other side of it, which is what makes the floor a safety
    ///         property rather than a preference — and it is new with BEM, because
    ///         at 18 decimals there was no reachable other side to measure.
    ///
    ///         The degenerate base is reached by deriving it the way `launch()`
    ///         does and poking it into storage, since `setDefaultSoftCap` will not
    ///         let a real launch get there. Both halves are asserted: that the
    ///         arithmetic really does degenerate, and that the factory really does
    ///         refuse. Either alone would be describing a hazard without its
    ///         guard, or a guard without its hazard.
    function test_belowTheSoftCapFloor_theLadderStopsStepping() public {
        ToshLaunchpadHook h = new ToshLaunchpadHook(
            address(poolManager),
            address(vault),
            address(factory),
            payable(address(ladder)),
            platformTreasury,
            address(quote)
        );

        // 21 BEM is the largest raise whose shelf base still falls short: 18.9 to
        // the LP, p0 = 500, shelfP0 = 525 — one unit under the break-even.
        uint256 degenerate = 21e8;
        uint256 lp = degenerate - (degenerate * h.REFERRAL_BPS()) / 10_000;
        uint256 base = (((lp * 1e18) / h.GENESIS_LP_SUPPLY()) * h.SHELF_PREMIUM_BPS()) / 10_000;

        assertEq(base, 525, "21 BEM lands exactly on the last degenerate base");
        assertEq(_firstStepAt(h, base), 0, "and at that base shelves 0 and 1 cost the same");

        vm.prank(admin);
        vm.expectRevert(ToshFactory.InvalidSoftCap.selector);
        factory.setDefaultSoftCap(degenerate);
    }

    /// @dev Pro-rata genesis claims never overshoot GENESIS_CLAIM_SUPPLY.
    function testFuzz_claimGenesis_proRataNeverExceedsClaimSupply(uint256 d1, uint256 d2) public {
        d1 = bound(d1, 1, 40e8);
        d2 = bound(d2, 1, 40e8);

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
        // Floor re-based from `1e15` to `1e6`. The old figure was "a thousandth of
        // an ether" — comfortably inside a 1000-ether ceiling. The ceiling here is
        // 1000 BEM = 1e11, so `1e15` is now ABOVE it and `bound` rejects the range
        // outright rather than fuzzing a narrower one.
        uint256 q = bound(uint256(quota), 1e6, factory.maxPogAllocationLimit());
        uint256 d1 = bound(uint256(deposit1), 1, q);
        uint256 d2 = bound(uint256(deposit2), 1, q);

        (, ToshLaunchpadHook hook) = _createProject();
        address fuzzUser = makeAddr("fuzzPogUser");
        // Fund both legs up front. The old reason was that the reverting path
        // still had to ATTACH `d2` as value, so a budget of `q` was short; that
        // is gone with `msg.value`, but the funding still has to cover both legs
        // because the quota check happens after the pull is authorised and a
        // balance-shaped revert would mask the `QuotaExceeded` this asserts.
        quote.mint(fuzzUser, 2 * q);
        vm.prank(fuzzUser);
        quote.approve(address(factory), type(uint256).max);
        _register(fuzzUser, q);

        vm.startPrank(fuzzUser);
        factory.deposit(address(hook), address(0), d1);
        assertEq(factory.totalGenesisDeposited(fuzzUser), d1);

        if (d1 + d2 > q) {
            vm.expectRevert(ToshFactory.QuotaExceeded.selector);
            factory.deposit(address(hook), address(0), d2);
        } else {
            factory.deposit(address(hook), address(0), d2);
            assertEq(factory.totalGenesisDeposited(fuzzUser), d1 + d2);
        }
        vm.stopPrank();
    }

    /// @dev A positive token request never quotes a free (zero-cost) mint.
    function testFuzz_quoteMint_noFreeMintForPositiveRequest(uint256 tokens) public {
        (, ToshLaunchpadHook hook) = _createProject();
        _deposit(makeAddr("funder"), hook, SOFT_CAP);
        _launch(hook);
        _openLadder(hook, 1e8);

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
        _openLadder(hook, 1e8);

        uint256 cap = hook.maxMintable();
        assertGt(cap, hook.TIER_SIZE(), "the fuzz range must be able to straddle shelves");
        // Floor at one whole token: sub-wei-cost orders trip the L-01 dust
        // guard, which is its own test.
        tokens = bound(tokens, 1e18, cap);

        uint256 quoted = hook.quoteMint(tokens);

        address buyer = makeAddr("spanBuyer");
        uint256 offered = 10_000e8;
        quote.mint(buyer, offered);
        vm.prank(buyer);
        quote.approve(address(hook), offered);

        vm.prank(buyer);
        uint256 charged = hook.mintBondingCurve(tokens, offered);

        assertEq(charged, quoted, "the quote must be exactly what the mint charges");
        // ⚠ THE OLD ASSERTION WAS ABOUT A REFUND, and there is no longer one to
        // assert. `assertEq(buyer.balance, offered - quoted)` held because the
        // buyer sent `offered` and got the difference back; a pull moves exactly
        // `quoted` and never holds the rest, so the same figure now means
        // something stronger — the surplus was never taken in the first place.
        assertEq(quote.balanceOf(buyer), offered - quoted, "only the quoted amount may be pulled");
        assertEq(
            quote.allowance(buyer, address(hook)),
            offered - quoted,
            "and only the quoted amount may be spent from the allowance"
        );
    }

    /// @dev Sweeping a span costs exactly what the same order costs when chopped
    ///      shelf by shelf —the fill is a pure accounting change, not a repricing.
    function testFuzz_SpanCostEqualsChoppedCost(uint256 tokens) public {
        (, ToshLaunchpadHook swept) = _createProject("SweptFuzz", "SWF");
        _deposit(makeAddr("funderA"), swept, SOFT_CAP);
        _launch(swept);
        _openLadder(swept, 1e8);

        (, ToshLaunchpadHook chopped) = _createProject("ChoppedFuzz", "CHF");
        _deposit(makeAddr("funderB"), chopped, SOFT_CAP);
        _launch(chopped);
        _openLadder(chopped, 1e8);

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
        quote.mint(buyer, 20_000e8);
        // Both hooks, because the point of this test is that the same buyer pays
        // the same total through two different call shapes.
        vm.startPrank(buyer);
        quote.approve(address(swept), type(uint256).max);
        quote.approve(address(chopped), type(uint256).max);
        vm.stopPrank();

        vm.prank(buyer);
        uint256 sweptCost = swept.mintBondingCurve(tokens, 5000e8);

        uint256 choppedCost;
        uint256 left = tokens;
        vm.startPrank(buyer);
        while (left > 0) {
            uint256 take = chopped.TIER_SIZE() - chopped.currentTierSold();
            if (take > left) take = left;
            choppedCost += chopped.mintBondingCurve(take, 5000e8);
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
