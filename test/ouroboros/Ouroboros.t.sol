// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, stdStorage, StdStorage} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OuroborosToken} from "../../src/ouroboros/OuroborosToken.sol";
import {OuroborosMint} from "../../src/ouroboros/OuroborosMint.sol";
import {OuroborosBidBook} from "../../src/ouroboros/OuroborosBidBook.sol";
import {
    MockUsdt,
    MockV2Pair,
    MockV2Factory,
    MockV2Router,
    MockFeed,
    MockRegistry,
    MockSafe,
    MockOddPool
} from "./utils/OuroMocks.sol";

/// Answers every call with two true words: not a Safe's `isOwner` reply.
contract TruthyFallback {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1), uint256(1));
    }
}

contract OuroborosTest is Test {
    using stdStorage for StdStorage;

    address constant WBNB = address(0xB0B);
    address constant VAULT = address(0x7A017);
    address treasury = makeAddr("treasury");
    address safe = makeAddr("safe");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address nobody = makeAddr("nobody");

    MockUsdt usdt;
    MockV2Factory factory;
    MockV2Router router;
    MockFeed feed;
    MockRegistry registry;
    OuroborosToken token;
    MockV2Pair pair;
    OuroborosMint mint;
    OuroborosBidBook book;

    uint64 l1Start;
    uint64 l2Start;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdt = new MockUsdt();
        factory = new MockV2Factory();
        router = new MockV2Router(address(factory), WBNB, usdt);
        router.setUsdtPerBnb(600 ether);
        feed = new MockFeed();
        feed.set(600e8, block.timestamp);
        registry = new MockRegistry();
        registry.setHandle(alice, "alice.ai");
        registry.setHandle(bob, "bob.ai");
        registry.setHandle(carol, "carol.ai");

        address[] memory blocked = new address[](1);
        blocked[0] = VAULT;
        token = new OuroborosToken(address(usdt), address(router), treasury, blocked);
        pair = MockV2Pair(factory.createPair(address(token), address(usdt)));

        l1Start = uint64(block.timestamp + 100);
        l2Start = l1Start + 2 hours + 1 days;
        mint = new OuroborosMint(
            OuroborosMint.Config({
                token: token,
                usdt: address(usdt),
                wbnb: WBNB,
                router: address(router),
                pair: address(pair),
                agentRegistry: address(registry),
                bnbUsdFeed: address(feed),
                treasury: treasury,
                owner: safe,
                l1Start: l1Start,
                l2Start: l2Start
            })
        );
        book = mint.bidBook();
        token.wire(address(mint), address(pair), l2Start);

        address[4] memory users = [alice, bob, carol, nobody];
        for (uint256 i; i < users.length; ++i) {
            usdt.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            usdt.approve(address(mint), type(uint256).max);
            vm.prank(users[i]);
            usdt.approve(address(book), type(uint256).max);
            vm.prank(users[i]);
            usdt.approve(address(router), type(uint256).max);
            vm.prank(users[i]);
            token.approve(address(book), type(uint256).max);
            vm.prank(users[i]);
            token.approve(address(router), type(uint256).max);
            vm.deal(users[i], 100 ether);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _mintL1(address user, uint256 shares) internal {
        vm.prank(user, user);
        mint.mintL1(shares, type(uint256).max, bytes32(0));
    }

    function _toLaunch() internal {
        vm.warp(l1Start);
        _mintL1(alice, 30);
        _mintL1(bob, 10);
        vm.warp(l1Start + 2 hours);
        mint.launch();
    }

    /// alice 30 and bob 10 as in `_toLaunch`, plus 50 seeders of 30, so the
    /// pool (1,108.8 USDT) takes a 30-share, 36 USDT mint under `MAX_MINT_POOL_BPS`.
    function _toL2() internal {
        vm.warp(l1Start);
        _mintL1(alice, 30);
        _mintL1(bob, 10);
        _seeders(50);
        vm.warp(l1Start + 2 hours);
        mint.launch();
        vm.warp(l2Start);
        _seedAsSafe();
    }

    function _seedAsSafe() internal {
        vm.prank(safe);
        mint.seedPool(0);
    }

    function _seeders(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address u = address(uint160(0x10000 + i));
            registry.setHandle(u, string.concat("seed", vm.toString(i), ".ai"));
            usdt.mint(u, 100 ether);
            vm.prank(u);
            usdt.approve(address(mint), type(uint256).max);
            vm.prank(u, u);
            mint.mintL1(30, type(uint256).max, bytes32(0));
        }
    }

    function _reserves() internal view returns (uint256 u, uint256 t) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (t, u) = pair.token0() == address(token) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _buy(address user, uint256 usdtIn) internal {
        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = address(token);
        vm.prank(user, user);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(usdtIn, 0, path, user, block.timestamp);
    }

    function _sell(address user, uint256 tokensIn) internal {
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(usdt);
        vm.prank(user, user);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensIn, 0, path, user, block.timestamp);
    }

    // ── L1 ───────────────────────────────────────────────────────────────────

    function test_phases() public {
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.Pending));
        vm.warp(l1Start);
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.L1));
        _mintL1(alice, 1);
        vm.warp(l1Start + 2 hours);
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.AwaitLaunch));
        mint.launch();
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.L1_5));
        vm.warp(l2Start);
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.L2));
    }

    function test_l1SplitsPaymentAndOpensAtPar() public {
        _toLaunch();
        assertEq(usdt.balanceOf(treasury), 40 * 0.18 ether);

        // L1 ends with only the L1 allocation minted and the pool still empty.
        assertEq(token.totalSupply(), mint.L1_ALLOCATION());
        assertEq(pair.totalSupply(), 0);
        assertEq(usdt.balanceOf(address(mint)), 40 * 0.72 ether);
        vm.expectRevert(OuroborosMint.WrongPhase.selector);
        _seedAsSafe();

        vm.warp(l2Start);
        _seedAsSafe();
        assertTrue(token.tradingOpen());
        vm.expectRevert(OuroborosMint.WrongPhase.selector);
        _seedAsSafe();

        (uint256 u, uint256 t) = _reserves();
        assertEq(u, 40 * 0.72 ether);
        assertEq(t, mint.POOL_ALLOCATION());
        assertEq(token.totalSupply(), token.CAP());

        // L1 price per token equals the opening pool price.
        uint256 l1PricePerToken = 40 * 0.9 ether * 1e18 / mint.L1_ALLOCATION();
        uint256 poolPricePerToken = u * 1e18 / t;
        assertApproxEqRel(l1PricePerToken, poolPricePerToken, 1e9);

        vm.prank(alice);
        mint.claimL1();
        assertEq(token.balanceOf(alice), mint.L1_ALLOCATION() * 30 / 40);
        vm.prank(alice);
        vm.expectRevert(OuroborosMint.NothingToClaim.selector);
        mint.claimL1();
    }

    /// alice sells into a 10 USDT bid at `multiple` x the L1 price: 10 of the
    /// 36 USDT L1 raise, above the 5 % that lets the pool open above par.
    function _l15Trade(uint256 multiple) internal returns (uint256 l1Price) {
        vm.prank(alice);
        mint.claimL1();
        (l1Price,) = mint.seedTerms();
        vm.prank(bob);
        uint256 id = book.placeBid(10 ether, multiple * l1Price);
        uint256 qty = book.tokensToFill(id);
        vm.prank(alice);
        book.fill(id, qty, 0);
    }

    function test_seedOpensAtSignerPrice() public {
        _toLaunch();
        (, bool met) = mint.seedTerms();
        assertFalse(met);
        uint256 l1Price = _l15Trade(2);
        (, met) = mint.seedTerms();
        assertTrue(met);
        assertApproxEqAbs(book.filledUsdt(), 10 ether, 1);

        vm.warp(l2Start);
        vm.prank(safe);
        mint.seedPool(3 * l1Price);

        (uint256 u, uint256 t) = _reserves();
        assertEq(u, 40 * 0.72 ether);
        assertEq(t, u * 1e18 / (3 * l1Price));
        assertEq(mint.seedPrice(), 3 * l1Price);
        assertEq(mint.seedTokens(), t);
        assertApproxEqRel(u * 1e18 / t, 3 * l1Price, 1e9);
        // The tokens left out of the pool are never minted.
        assertEq(token.totalSupply(), mint.L1_ALLOCATION() + t);
        assertTrue(token.tradingOpen());
    }

    function test_seedBelowL1PriceOpensAtPar() public {
        _toLaunch();
        uint256 l1Price = _l15Trade(2);
        vm.warp(l2Start);
        vm.prank(safe);
        mint.seedPool(l1Price / 2);
        (, uint256 t) = _reserves();
        assertEq(t, mint.POOL_ALLOCATION());
        assertEq(token.totalSupply(), token.CAP());
    }

    function test_seedWithThinL15OpensAtPar() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();
        (uint256 l1Price,) = mint.seedTerms();
        // 1.7 USDT traded, under 5 % of the 36 USDT raise.
        vm.prank(bob);
        uint256 id = book.placeBid(1.7 ether, 2 * l1Price);
        uint256 qty = book.tokensToFill(id);
        vm.prank(alice);
        book.fill(id, qty, 0);
        (, bool met) = mint.seedTerms();
        assertFalse(met);

        vm.warp(l2Start);
        vm.prank(safe);
        mint.seedPool(5 * l1Price);
        (, uint256 t) = _reserves();
        assertEq(t, mint.POOL_ALLOCATION());
        assertEq(mint.seedPrice(), 40 * 0.72 ether * 1e18 / mint.POOL_ALLOCATION());
    }

    function test_seedPriceLeavingTooFewTokensReverts() public {
        _toLaunch();
        uint256 l1Price = _l15Trade(2);
        vm.warp(l2Start);
        vm.prank(safe);
        vm.expectRevert(OuroborosMint.PriceTooHigh.selector);
        mint.seedPool(l1Price * 1e6);
    }

    /// Three days into L2 with no seeding, anyone opens the pool, at par
    /// whatever price they pass.
    function test_anyoneSeedsAtParAfterDelay() public {
        _toLaunch();
        uint256 l1Price = _l15Trade(2);
        vm.warp(l2Start + mint.OPEN_SEED_DELAY() - 1);
        vm.prank(carol);
        vm.expectRevert(OuroborosMint.NotSeeder.selector);
        mint.seedPool(3 * l1Price);

        vm.warp(l2Start + mint.OPEN_SEED_DELAY());
        vm.prank(carol);
        mint.seedPool(3 * l1Price);
        assertTrue(mint.poolSeeded());
        assertTrue(token.tradingOpen());
        (, uint256 t) = _reserves();
        assertEq(t, mint.POOL_ALLOCATION());
        assertEq(mint.seedPrice(), 40 * 0.72 ether * 1e18 / mint.POOL_ALLOCATION());
    }

    /// A pause keeps the pool shut past the delay; signers can still seed.
    function test_openSeedingWaitsForUnpause() public {
        _toLaunch();
        vm.prank(safe);
        mint.setPaused(true);
        vm.warp(l2Start + mint.OPEN_SEED_DELAY());
        vm.prank(carol);
        vm.expectRevert(OuroborosMint.Paused.selector);
        mint.seedPool(0);

        vm.prank(safe);
        mint.setPaused(false);
        vm.prank(carol);
        mint.seedPool(0);
        assertTrue(mint.poolSeeded());
    }

    /// An owner contract whose fallback answers anything makes nobody a seeder.
    function test_nonSafeOwnerAnswerIsNotTrusted() public {
        TruthyFallback odd = new TruthyFallback();
        vm.prank(safe);
        mint.transferOwnership(address(odd));
        vm.prank(address(odd));
        mint.acceptOwnership();
        assertFalse(mint.isSeeder(carol));
    }

    function test_renounceOwnershipReverts() public {
        vm.prank(safe);
        vm.expectRevert(OuroborosMint.RenounceDisabled.selector);
        mint.renounceOwnership();
        assertEq(mint.owner(), safe);
    }

    /// A second mint before the first unlocks leaves the first's unlock time alone.
    function test_eachMintVestsOnItsOwnClock() public {
        _toL2();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(carol, carol);
        mint.mintL2(5, type(uint256).max, 0, bytes32(0));
        (uint256 first,,) = mint.vestOf(carol);

        vm.warp(t0 + 170);
        vm.prank(carol, carol);
        mint.mintL2(5, type(uint256).max, 0, bytes32(0));
        (uint256 both,, uint256 lastUnlock) = mint.vestOf(carol);
        assertEq(lastUnlock, t0 + 170 + 180);

        vm.warp(t0 + 180);
        (uint256 locked, uint256 claimable,) = mint.vestOf(carol);
        assertEq(claimable, first);
        assertEq(locked, both - first);
        vm.prank(carol);
        mint.claim();
        assertEq(token.balanceOf(carol), first);
        vm.prank(carol);
        vm.expectRevert(OuroborosMint.NothingToClaim.selector);
        mint.claim();

        vm.warp(t0 + 350);
        vm.prank(carol);
        mint.claim();
        assertEq(token.balanceOf(carol), both);
        (locked, claimable,) = mint.vestOf(carol);
        assertEq(locked + claimable, 0);
        assertEq(mint.totalVesting(), 0);
    }

    /// A mint logs the partner code it was given, so a batched call from a
    /// smart account keeps its referral.
    function test_mintsLogTheirReferralCode() public {
        bytes32 ref = bytes32("alpha7");
        vm.warp(l1Start);
        vm.recordLogs();
        vm.prank(alice, alice);
        mint.mintL1(3, type(uint256).max, ref);
        (,,, bytes32 l1Ref) = abi.decode(_mintLog(OuroborosMint.L1Minted.selector), (uint256, uint256, bool, bytes32));
        assertEq(l1Ref, ref, "L1 ref");

        _seeders(50);
        vm.warp(l1Start + 2 hours);
        mint.launch();
        vm.warp(l2Start);
        _seedAsSafe();
        vm.recordLogs();
        vm.prank(bob, bob);
        mint.mintL2(2, type(uint256).max, 0, ref);
        (,,,,,, bytes32 l2Ref) = abi.decode(
            _mintLog(OuroborosMint.L2Minted.selector), (uint256, uint256, uint256, uint256, uint256, bool, bytes32)
        );
        assertEq(l2Ref, ref, "L2 ref");
    }

    function _mintLog(bytes32 topic) internal returns (bytes memory data) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(mint) && logs[i].topics[0] == topic) return logs[i].data;
        }
        revert("no mint log");
    }

    function test_l1Quota() public {
        vm.warp(l1Start);
        vm.prank(alice, alice);
        vm.expectRevert(OuroborosMint.BadShares.selector);
        mint.mintL1(31, type(uint256).max, bytes32(0));

        _mintL1(alice, 20);
        vm.prank(alice, alice);
        vm.expectRevert(OuroborosMint.QuotaExceeded.selector);
        mint.mintL1(11, type(uint256).max, bytes32(0));
        assertEq(mint.remainingShares(alice), 10);

        vm.prank(nobody, nobody);
        vm.expectRevert(OuroborosMint.NoAgentId.selector);
        mint.mintL1(1, type(uint256).max, bytes32(0));

        vm.prank(bob, address(0xC0FFEE));
        vm.expectRevert(OuroborosMint.NotAWallet.selector);
        mint.mintL1(1, type(uint256).max, bytes32(0));
    }

    function test_quotaSpansL1AndL2() public {
        _toL2();
        vm.prank(alice, alice);
        vm.expectRevert(OuroborosMint.QuotaExceeded.selector);
        mint.mintL2(1, type(uint256).max, 0, bytes32(0));

        vm.prank(bob, bob);
        mint.mintL2(20, type(uint256).max, 0, bytes32(0));
        assertEq(mint.remainingShares(bob), 0);
    }

    function test_pauseOnlyByOwner() public {
        vm.warp(l1Start);
        vm.expectRevert();
        mint.setPaused(true);
        vm.prank(safe);
        mint.setPaused(true);
        vm.prank(alice, alice);
        vm.expectRevert(OuroborosMint.Paused.selector);
        mint.mintL1(1, type(uint256).max, bytes32(0));
    }

    function test_launchWithNoSharesFails() public {
        vm.warp(l1Start + 2 hours);
        mint.launch();
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.Failed));
        assertEq(token.totalSupply(), 0);
    }

    function test_launchSkimsDonations() public {
        vm.warp(l1Start);
        _mintL1(alice, 10);
        usdt.mint(address(pair), 5 ether);
        vm.warp(l1Start + 2 hours);
        mint.launch();
        vm.warp(l2Start);
        _seedAsSafe();
        (uint256 u,) = _reserves();
        assertEq(u, 10 * 0.72 ether);
        assertEq(usdt.balanceOf(treasury), 10 * 0.18 ether + 5 ether);
    }

    function test_launchNeutralisesSyncedDonation() public {
        vm.warp(l1Start);
        _mintL1(alice, 10);
        usdt.mint(address(pair), 2 ether);
        vm.warp(l1Start + 2 hours);
        mint.launch();
        pair.sync();
        vm.warp(l2Start);
        _seedAsSafe();
        (uint256 u, uint256 t) = _reserves();
        assertEq(u, 10 * 0.72 ether);
        assertEq(t, mint.POOL_ALLOCATION());
        assertEq(usdt.balanceOf(treasury), 10 * 0.18 ether + 2 ether);
    }

    function test_blockedVenueRejected() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();
        vm.prank(alice);
        vm.expectRevert(OuroborosToken.ForeignPair.selector);
        token.transfer(VAULT, 1 ether);
    }

    function test_claimL1BeforeLaunchReverts() public {
        vm.warp(l1Start);
        _mintL1(alice, 1);
        vm.prank(alice);
        vm.expectRevert(OuroborosMint.WrongPhase.selector);
        mint.claimL1();
    }

    function test_noMintDuringL15() public {
        _toLaunch();
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.WrongPhase.selector);
        mint.mintL2(1, type(uint256).max, 0, bytes32(0));
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.WrongPhase.selector);
        mint.mintL1(1, type(uint256).max, bytes32(0));
    }

    function test_soldOutCapsTheLastPurchase() public {
        _seedL1(200);
        vm.warp(l2Start);
        _seedAsSafe();
        stdstore.target(address(mint)).sig("l2Minted()").checked_write(mint.L2_TOTAL_SHARES() - 5);
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.SoldOut.selector);
        mint.mintL2(6, type(uint256).max, 0, bytes32(0));
        vm.prank(carol, carol);
        mint.mintL2(5, type(uint256).max, 0, bytes32(0));
        assertEq(uint256(mint.phase()), uint256(OuroborosMint.Phase.SoldOut));
    }

    /// `n` seeders take 30 L1 shares each, then the pool launches.
    function _seedL1(uint256 n) internal {
        vm.warp(l1Start);
        _seeders(n);
        vm.warp(l1Start + 2 hours);
        mint.launch();
    }

    /// Mint, wait out the vest, sell everything into an otherwise idle pool.
    /// Priced after its own liquidity lands, the round trip loses the sell
    /// tax and pair fee net of the 1 % bonus.
    function test_mintThenSellRoundTripLoses() public {
        _seedL1(200);
        vm.warp(l2Start);
        _seedAsSafe();

        uint256 before = usdt.balanceOf(carol);
        (uint256 cost,) = mint.quoteL2(30);
        vm.prank(carol, carol);
        mint.mintL2(30, type(uint256).max, 0, bytes32(0));
        vm.warp(block.timestamp + 180);
        vm.prank(carol);
        mint.claim();
        vm.roll(block.number + 1);
        _sell(carol, token.balanceOf(carol));
        uint256 afterBal = usdt.balanceOf(carol);
        emit log_named_int("round-trip pnl (USDT wei)", int256(afterBal) - int256(before));
        assertLt(afterBal, before);
        assertGt(afterBal, before - cost / 100);
    }

    /// 40 L1 shares leave a 28.8 USDT pool: a 2.88 USDT cap, two 1.2 USDT shares.
    function test_mintAboveTenPercentOfPoolReverts() public {
        _toLaunch();
        vm.warp(l2Start);
        assertEq(mint.maxL2Cost(), 40 * 0.72 ether * 1_000 / 10_000);
        _seedAsSafe();
        (uint256 u,) = _reserves();
        assertEq(mint.maxL2Cost(), u * 1_000 / 10_000);
        (uint256 cost, uint256 quoted) = mint.quoteL2(3);
        assertGt(cost, mint.maxL2Cost());
        assertEq(quoted, 0);
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.MintTooLarge.selector);
        mint.mintL2(3, type(uint256).max, 0, bytes32(0));
        vm.prank(carol, carol);
        mint.mintL2(2, type(uint256).max, 0, bytes32(0));
    }

    /// Sell to depress the price, mint, then spend the sale proceeds buying back,
    /// all in one block (what an EIP-7702 account can batch). Same USDT out as a
    /// plain mint, and fewer tokens at the end.
    function test_depressThenMintDoesNotPay() public {
        _toL2();
        vm.prank(bob);
        mint.claimL1();
        uint256 held = token.balanceOf(bob);
        uint256 snap = vm.snapshotState();

        vm.prank(bob, bob);
        mint.mintL2(20, type(uint256).max, 0, bytes32(0));
        uint256 plain = held + _vested(bob);
        vm.revertToState(snap);

        uint256 usdt0 = usdt.balanceOf(bob);
        _sell(bob, held);
        uint256 proceeds = usdt.balanceOf(bob) - usdt0;
        vm.prank(bob, bob);
        mint.mintL2(20, type(uint256).max, 0, bytes32(0));
        _buy(bob, proceeds);
        uint256 pushed = token.balanceOf(bob) + _vested(bob);

        emit log_named_uint("pushed / plain (bps)", pushed * 10_000 / plain);
        assertLt(pushed, plain);
    }

    function _vested(address user) internal view returns (uint256) {
        (uint256 locked, uint256 claimable,) = mint.vestOf(user);
        return locked + claimable;
    }

    // ── BNB payment ──────────────────────────────────────────────────────────

    function test_bnbPaymentSurplusAndRefund() public {
        vm.warp(l1Start);
        uint256 cost = 10 * 0.9 ether;
        uint256 bnbIn = mint.quoteBnb(cost);
        assertApproxEqAbs(bnbIn, cost * 10_100 / 10_000 / 600, 1);

        uint256 before = alice.balance;
        vm.prank(alice, alice);
        mint.mintL1{value: 1 ether}(10, 0, bytes32(0));
        assertEq(before - alice.balance, bnbIn);
        // Router pays the Chainlink rate, so the 1 % margin surfaces as surplus.
        assertApproxEqAbs(usdt.balanceOf(treasury), cost * 2_000 / 10_000 + cost / 100, 1e6);
    }

    function test_bnbPaymentRevertsWhenSwapShort() public {
        vm.warp(l1Start);
        router.setUsdtPerBnb(590 ether);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT_AMOUNT"));
        mint.mintL1{value: 1 ether}(10, 0, bytes32(0));
    }

    function test_bnbStaleFeedReverts() public {
        vm.warp(l1Start);
        feed.set(600e8, block.timestamp - 2 hours);
        vm.prank(alice, alice);
        vm.expectRevert(OuroborosMint.StaleFeed.selector);
        mint.mintL1{value: 1 ether}(1, 0, bytes32(0));
    }

    // ── L1.5 ─────────────────────────────────────────────────────────────────

    function test_l15PoolClosedWalletsOpen() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();

        vm.prank(alice);
        token.transfer(carol, 1 ether);
        assertEq(token.balanceOf(carol), 1 ether);

        vm.prank(alice);
        vm.expectRevert(OuroborosToken.TradingNotOpen.selector);
        token.transfer(address(pair), 1 ether);
        assertEq(pair.totalSupply(), 0);
    }

    /// At `l2Start`, until a Safe signer seeds the pool, nobody can put tokens
    /// in the pair, so nobody else can set the opening price, and L2 waits.
    function test_onlySafeSignersSeedPool() public {
        MockSafe multisig = new MockSafe();
        address signer = makeAddr("signer");
        multisig.setOwner(signer, true);
        vm.prank(safe);
        mint.transferOwnership(address(multisig));
        vm.prank(address(multisig));
        mint.acceptOwnership();

        _seedL1(200);
        vm.prank(address(0x10000));
        mint.claimL1();
        vm.warp(l2Start);
        assertFalse(token.tradingOpen());
        vm.prank(address(0x10000));
        vm.expectRevert(OuroborosToken.TradingNotOpen.selector);
        token.transfer(address(pair), 1 ether);

        (uint256 cost, uint256 quoted) = mint.quoteL2(30);
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.PoolNotSeeded.selector);
        mint.mintL2(30, cost, 0, bytes32(0));

        assertFalse(mint.isSeeder(carol));
        vm.prank(carol);
        vm.expectRevert(OuroborosMint.NotSeeder.selector);
        mint.seedPool(0);
        vm.prank(safe);
        vm.expectRevert(OuroborosMint.NotSeeder.selector);
        mint.seedPool(0);

        assertTrue(mint.isSeeder(signer));
        vm.prank(signer);
        mint.seedPool(0);
        vm.prank(carol, carol);
        mint.mintL2(30, cost, quoted * 9_999 / 10_000, bytes32(0));
        assertTrue(mint.poolSeeded());
        assertTrue(token.tradingOpen());
        assertEq(token.totalSupply(), token.CAP());
        vm.roll(block.number + 1);
        _buy(bob, 1 ether);
        assertGt(token.balanceOf(bob), 0);
    }

    function test_bidBook() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();

        uint256 price = 0.000001 ether; // USDT per token
        vm.prank(carol);
        uint256 id = book.placeBid(100 ether, price);

        uint256 tokensIn = 50_000_000 ether;
        uint256 aliceUsdt = usdt.balanceOf(alice);
        vm.prank(alice);
        book.fill(id, tokensIn, 0);

        uint256 gross = 50 ether;
        assertEq(token.balanceOf(carol), tokensIn * 98 / 100);
        assertEq(token.balanceOf(treasury), tokensIn * 2 / 100);
        assertEq(usdt.balanceOf(alice) - aliceUsdt, gross * 98 / 100);
        assertEq(usdt.balanceOf(treasury), 40 * 0.18 ether + gross * 2 / 100);
        assertEq(book.tokensToFill(id), 50_000_000 ether);

        vm.prank(alice);
        vm.expectRevert(OuroborosBidBook.FillTooLarge.selector);
        book.fill(id, 60_000_000 ether, 0);

        vm.warp(l2Start);
        vm.prank(alice);
        vm.expectRevert(OuroborosBidBook.MarketClosed.selector);
        book.fill(id, 1 ether, 0);

        uint256 carolUsdt = usdt.balanceOf(carol);
        vm.prank(carol);
        book.cancel(id);
        assertEq(usdt.balanceOf(carol) - carolUsdt, 50 ether);
    }

    // ── L2 ───────────────────────────────────────────────────────────────────

    function test_ladderPrices() public view {
        assertEq(mint.ladderPrice(1), 1.2 ether);
        assertEq(mint.ladderPrice(10_000), 1.2 ether);
        assertEq(mint.ladderPrice(10_001), 1.28 ether);
        assertEq(mint.ladderPrice(11_001), 1.36 ether);
        assertEq(mint.ladderPrice(20_000), 2.0 ether);
        assertEq(mint.ladderPrice(20_001), 2.08 ether);
        assertEq(mint.ladderPrice(100_000), 3.344 ether);
        assertEq(mint.ladderPrice(100_001), 3.36 ether);
        assertEq(mint.ladderPrice(1_000_000), 4.784 ether);
        assertEq(mint.ladderPrice(1_000_001), 4.8 ether);
        assertEq(mint.ladderPrice(5_000_000), 8.78 ether);
        assertEq(mint.ladderPrice(5_000_001), 8.8 ether);
        assertEq(mint.ladderPrice(21_000_000), 15.18 ether);
        assertEq(mint.ladderCost(9_995, 10), 5 * 1.2 ether + 5 * 1.28 ether);
    }

    function test_l2MintBurnsEqualAndAddsLiquidity() public {
        _toL2();
        (uint256 u0, uint256 t0) = _reserves();
        uint256 lp0 = pair.totalSupply();
        (uint256 cost, uint256 quoted) = mint.quoteL2(20);
        assertEq(cost, 20 * 1.2 ether);
        assertApproxEqRel(quoted, cost * t0 / (u0 + cost * 4 / 5) * 10_100 / 10_000, 1e6);

        uint256 treasury0 = usdt.balanceOf(treasury);
        vm.prank(carol, carol);
        mint.mintL2(20, cost, quoted * 9_999 / 10_000, bytes32(0));

        assertEq(token.totalSupply(), token.CAP());
        assertEq(usdt.balanceOf(treasury) - treasury0, cost / 5);
        (uint256 u1,) = _reserves();
        assertApproxEqAbs(u1, u0 + cost * 4 / 5, 1e6);
        assertGt(pair.totalSupply(), lp0);
        assertApproxEqRel(mint.totalBurned(), quoted, 1e12);
        assertLe(mint.pendingQuote(), 10);

        (uint256 locked, uint256 claimable,) = mint.vestOf(carol);
        assertEq(locked, mint.totalBurned());
        assertEq(claimable, 0);
        vm.prank(carol);
        vm.expectRevert(OuroborosMint.NothingToClaim.selector);
        mint.claim();

        vm.warp(block.timestamp + 180);
        vm.prank(carol);
        mint.claim();
        assertEq(token.balanceOf(carol), locked);
    }

    function test_l2SlippageGuards() public {
        _toL2();
        (uint256 cost, uint256 quoted) = mint.quoteL2(5);
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.CostAboveMax.selector);
        mint.mintL2(5, cost - 1, 0, bytes32(0));
        vm.prank(carol, carol);
        vm.expectRevert(OuroborosMint.BelowMinTokens.selector);
        mint.mintL2(5, cost, quoted * 10_001 / 10_000, bytes32(0));
    }

    // ── Trading tax ──────────────────────────────────────────────────────────

    function test_buyTaxAccruesSellTaxBurnsAndSwaps() public {
        _toL2();
        (uint256 u, uint256 t) = _reserves();
        uint256 usdtIn = 1 ether;
        uint256 out = usdtIn * 9975 * t / (u * 10_000 + usdtIn * 9975);
        _buy(carol, usdtIn);
        uint256 fee = out * 125 / 10_000;
        assertEq(token.balanceOf(carol), out - fee);
        assertEq(token.balanceOf(address(token)), fee);

        vm.roll(block.number + 1);
        uint256 supply0 = token.totalSupply();
        uint256 treasury0 = usdt.balanceOf(treasury);
        uint256 sellAmt = token.balanceOf(carol);
        _sell(carol, sellAmt);
        assertEq(supply0 - token.totalSupply(), sellAmt / 100);
        assertGt(usdt.balanceOf(treasury), treasury0);
        assertEq(token.balanceOf(address(token)), 0);
    }

    function test_walletTransfersUntaxed() public {
        _toL2();
        vm.prank(alice);
        mint.claimL1();
        vm.prank(alice);
        token.transfer(carol, 1000 ether);
        assertEq(token.balanceOf(carol), 1000 ether);
    }

    function test_foreignPairRejected() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();
        MockUsdt other = new MockUsdt();
        address rogue = factory.createPair(address(token), address(other));
        vm.prank(alice);
        vm.expectRevert(OuroborosToken.ForeignPair.selector);
        token.transfer(rogue, 1 ether);
    }

    /// Permissionless AMMs on BSC that do not use `token0`/`token1`, and the
    /// ERC-4626 vaults EulerSwap trades out of.
    function test_otherAmmPoolsRejected() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();
        string[10] memory sigs = [
            "tokenX()",
            "tokenY()",
            "getTokenX()",
            "getTokenY()",
            "tokenA()",
            "tokenB()",
            "_BASE_TOKEN_()",
            "_QUOTE_TOKEN_()",
            "underlyingToken()",
            "asset()"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            address pool = address(new MockOddPool(sigs[i], address(token), false, 0));
            vm.prank(alice);
            vm.expectRevert(OuroborosToken.ForeignPair.selector);
            token.transfer(pool, 1 ether);
        }
        for (uint256 i; i < 4; ++i) {
            address pool = address(new MockOddPool("coins(uint256)", address(token), true, i));
            vm.prank(alice);
            vm.expectRevert(OuroborosToken.ForeignPair.selector);
            token.transfer(pool, 1 ether);
        }
        // A pool of the same AMM for other tokens is just a contract.
        address unrelated = address(new MockOddPool("tokenX()", address(usdt), false, 0));
        vm.prank(alice);
        token.transfer(unrelated, 1 ether);
        assertEq(token.balanceOf(unrelated), 1 ether);
    }

    /// A pair's address is known before it is deployed, and an address with no
    /// code passes the probe. Tokens sent there first must still never leave
    /// it, or the pair becomes an ask market in L1.5 and an untaxed one in L2.
    function test_prefundedForeignPairCannotPayOut() public {
        _toLaunch();
        vm.prank(alice);
        mint.claimL1();
        MockUsdt other = new MockUsdt();
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.prank(alice);
        token.transfer(predicted, 1_000_000 ether);

        address rogue = factory.createPair(address(token), address(other));
        assertEq(rogue, predicted);
        other.mint(rogue, 1_000 ether);
        MockV2Pair(rogue).mint(alice);

        (uint256 out0, uint256 out1) = MockV2Pair(rogue).token0() == address(token)
            ? (uint256(1 ether), uint256(0))
            : (uint256(0), uint256(1 ether));
        other.mint(rogue, 10 ether);
        vm.expectRevert(OuroborosToken.ForeignPair.selector);
        MockV2Pair(rogue).swap(out0, out1, carol, "");
    }

    function test_onlyMinterHooks() public {
        vm.expectRevert(OuroborosToken.NotMinter.selector);
        token.mint(alice, 1);
        vm.expectRevert(OuroborosToken.NotMinter.selector);
        token.burnFromPair(1);
        vm.expectRevert(OuroborosToken.AlreadyWired.selector);
        token.wire(address(1), address(2), 0);
    }

    function testFuzz_l2SupplyFixed(uint8 rounds) public {
        _toL2();
        address[3] memory who = [carol, makeAddr("d"), makeAddr("e")];
        uint256 n = bound(rounds, 1, 3);
        for (uint256 i; i < n; ++i) {
            registry.setHandle(who[i], string.concat("u", vm.toString(i), ".ai"));
            usdt.mint(who[i], 1_000 ether);
            vm.prank(who[i]);
            usdt.approve(address(mint), type(uint256).max);
            vm.prank(who[i], who[i]);
            mint.mintL2(30, type(uint256).max, 0, bytes32(0));
            assertEq(token.totalSupply(), token.CAP());
        }
    }
}
