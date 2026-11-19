// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {OuroborosToken} from "../../src/ouroboros/OuroborosToken.sol";
import {OuroborosMint} from "../../src/ouroboros/OuroborosMint.sol";
import {OuroborosBidBook} from "../../src/ouroboros/OuroborosBidBook.sol";
import {MockUsdt, MockV2Pair, MockV2Factory, MockV2Router, MockFeed, MockRegistry} from "./utils/OuroMocks.sol";

/// @notice Drives the whole lifecycle with random actors: L1 mints, launch,
///         bids and fills, L2 mints in USDT or BNB, pool buys and sells,
///         claims, and the clock.
contract OuroHandler is Test {
    OuroborosToken public token;
    OuroborosMint public mint;
    OuroborosBidBook public book;
    MockUsdt public usdt;
    MockV2Router public router;
    MockFeed public feed;
    MockV2Pair public pair;

    address[] public actors;
    uint256[] public bidIds;

    uint256 public sellBurned;
    uint256 public calls;
    uint256 public okL1;
    uint256 public okL2;
    uint256 public okFill;
    uint256 public okSwap;

    constructor(
        OuroborosToken t,
        OuroborosMint m,
        OuroborosBidBook b,
        MockUsdt u,
        MockV2Router r,
        MockFeed f,
        MockV2Pair p,
        address[] memory a
    ) {
        token = t;
        mint = m;
        book = b;
        usdt = u;
        router = r;
        feed = f;
        pair = p;
        actors = a;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function warp(uint256 secs) external {
        calls++;
        // Short steps through L1's two hours, long ones after, so a run spends calls in every phase.
        uint256 step = block.timestamp < mint.l1End() ? 45 minutes : 10 hours;
        vm.warp(block.timestamp + bound(secs, 1, step));
        vm.roll(block.number + 1);
        feed.set(600e8, block.timestamp);
        if (!mint.launched() && block.timestamp >= mint.l1End() && mint.totalL1Shares() > 0) mint.launch();
    }

    function mintL1(uint256 seed, uint256 shares, bool bnb) external {
        calls++;
        address a = _actor(seed);
        shares = bound(shares, 1, 30);
        vm.prank(a, a);
        try mint.mintL1{value: bnb ? 1 ether : 0}(shares, type(uint256).max, bytes32(0)) {
            okL1++;
        } catch {}
    }

    /// Launch with no L1 shares ends the run in `Failed`, which leaves nothing to explore.
    function launch() external {
        calls++;
        if (mint.totalL1Shares() == 0) return;
        try mint.launch() {} catch {}
    }

    /// The Safe seeds the pool once L2 opens, at up to 4x the L1 price; until
    /// then L2 mints and pool trades revert.
    function seed(uint256 multipleBps) external {
        calls++;
        (uint256 l1Price,) = mint.seedTerms();
        vm.prank(mint.owner());
        try mint.seedPool(l1Price * bound(multipleBps, 0, 40_000) / 10_000) {} catch {}
    }

    function claimAll(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        vm.prank(a);
        try mint.claimL1() {} catch {}
        // A claim pays exactly the matured entries, never one still locked.
        (, uint256 matured,) = mint.vestOf(a);
        uint256 before = token.balanceOf(a);
        vm.prank(a);
        try mint.claim() {
            assertEq(token.balanceOf(a) - before, matured, "claim paid unmatured vest");
        } catch {
            assertEq(matured, 0, "matured vest not claimable");
        }
    }

    function mintL2(uint256 seed, uint256 shares, bool bnb) external {
        calls++;
        address a = _actor(seed);
        shares = bound(shares, 1, 30);
        if (mint.launched()) {
            // Shrink to what the 10 % pool cap admits, or every thin-pool run reverts.
            while (shares > 1 && mint.ladderCost(mint.l2Minted(), shares) > mint.maxL2Cost()) shares--;
        }
        vm.prank(a, a);
        try mint.mintL2{value: bnb ? 5 ether : 0}(shares, type(uint256).max, 0, bytes32(0)) {
            okL2++;
            // Buys can drain the pair like any AMM; the equal burn itself never goes below the floor.
            (uint112 r0, uint112 r1,) = pair.getReserves();
            assertGe(pair.token0() == address(token) ? r0 : r1, mint.MIN_POOL_TOKENS(), "burn under floor");
        } catch {}
    }

    function placeBid(uint256 seed, uint256 amount, uint256 price) external {
        calls++;
        address a = _actor(seed);
        amount = bound(amount, 1 ether, 200 ether);
        price = bound(price, 1e6, 1e12);
        vm.prank(a);
        try book.placeBid(amount, price) returns (uint256 id) {
            bidIds.push(id);
        } catch {}
    }

    function fill(uint256 seed, uint256 which, uint256 frac) external {
        calls++;
        if (bidIds.length == 0) return;
        address a = _actor(seed);
        uint256 id = bidIds[which % bidIds.length];
        uint256 max = book.tokensToFill(id);
        uint256 bal = token.balanceOf(a);
        uint256 qty = (max < bal ? max : bal) * bound(frac, 1, 100) / 100;
        vm.prank(a);
        try book.fill(id, qty, 0) {
            okFill++;
        } catch {}
    }

    function cancel(uint256 which) external {
        calls++;
        if (bidIds.length == 0) return;
        uint256 id = bidIds[which % bidIds.length];
        (address buyer,,) = book.bids(id);
        vm.prank(buyer);
        try book.cancel(id) {} catch {}
    }

    function buy(uint256 seed, uint256 amount) external {
        calls++;
        address a = _actor(seed);
        amount = bound(amount, 1e15, 500 ether);
        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = address(token);
        vm.prank(a, a);
        try router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, a, block.timestamp) {
            okSwap++;
        } catch {}
    }

    function sell(uint256 seed, uint256 frac) external {
        calls++;
        address a = _actor(seed);
        uint256 amount = token.balanceOf(a) * bound(frac, 1, 100) / 100;
        if (amount == 0) return;
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(usdt);
        uint256 supply = token.totalSupply();
        vm.prank(a, a);
        try router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, a, block.timestamp) {
            okSwap++;
            assertEq(supply - token.totalSupply(), amount / 100, "a sell burns exactly its 1% tax");
            sellBurned += supply - token.totalSupply();
        } catch {}
    }

    function bidCount() external view returns (uint256) {
        return bidIds.length;
    }
}

contract OuroborosInvariantTest is Test {
    OuroborosToken token;
    OuroborosMint mint;
    OuroborosBidBook book;
    MockUsdt usdt;
    MockV2Pair pair;
    OuroHandler handler;
    address[] actors;
    address[] seeders;

    function setUp() public {
        vm.warp(1_800_000_000);
        address treasury = makeAddr("treasury");
        usdt = new MockUsdt();
        MockV2Factory factory = new MockV2Factory();
        MockV2Router router = new MockV2Router(address(factory), address(0xB0B), usdt);
        router.setUsdtPerBnb(600 ether);
        MockFeed feed = new MockFeed();
        feed.set(600e8, block.timestamp);
        MockRegistry registry = new MockRegistry();

        token = new OuroborosToken(address(usdt), address(router), treasury, new address[](0));
        pair = MockV2Pair(factory.createPair(address(token), address(usdt)));
        uint64 l1Start = uint64(block.timestamp);
        uint64 l2Start = l1Start + 2 hours + 1 days;
        mint = new OuroborosMint(
            OuroborosMint.Config({
                token: token,
                usdt: address(usdt),
                wbnb: address(0xB0B),
                router: address(router),
                pair: address(pair),
                agentRegistry: address(registry),
                bnbUsdFeed: address(feed),
                treasury: treasury,
                owner: makeAddr("safe"),
                l1Start: l1Start,
                l2Start: l2Start
            })
        );
        book = mint.bidBook();
        token.wire(address(mint), address(pair), l2Start);

        for (uint256 i; i < 12; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            registry.setHandle(a, string.concat("inv", vm.toString(i), ".ai"));
            usdt.mint(a, 1_000_000 ether);
            vm.deal(a, 1_000 ether);
            vm.startPrank(a);
            usdt.approve(address(mint), type(uint256).max);
            usdt.approve(address(book), type(uint256).max);
            usdt.approve(address(router), type(uint256).max);
            token.approve(address(book), type(uint256).max);
            token.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }

        // L1-only seeders: 600 shares give a 432 USDT pool, so L2 mints clear
        // the 10 % pool cap however few shares the fuzzed actors buy.
        for (uint256 i; i < 20; ++i) {
            address s = address(uint160(0xB000 + i));
            seeders.push(s);
            registry.setHandle(s, string.concat("seed", vm.toString(i), ".ai"));
            usdt.mint(s, 27 ether);
            vm.prank(s);
            usdt.approve(address(mint), type(uint256).max);
            vm.prank(s, s);
            mint.mintL1(30, type(uint256).max, bytes32(0));
        }

        handler = new OuroHandler(token, mint, book, usdt, router, feed, pair, actors);
        vm.deal(address(handler), 1_000_000 ether);
        targetContract(address(handler));
        // Weight the clock and the two mints so a run crosses every phase.
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = OuroHandler.warp.selector;
        sel[1] = OuroHandler.warp.selector;
        sel[2] = OuroHandler.warp.selector;
        sel[3] = OuroHandler.mintL1.selector;
        sel[4] = OuroHandler.mintL1.selector;
        sel[5] = OuroHandler.mintL2.selector;
        sel[6] = OuroHandler.mintL2.selector;
        sel[7] = OuroHandler.claimAll.selector;
        sel[8] = OuroHandler.placeBid.selector;
        sel[9] = OuroHandler.fill.selector;
        sel[10] = OuroHandler.cancel.selector;
        sel[11] = OuroHandler.buy.selector;
        sel[12] = OuroHandler.sell.selector;
        sel[13] = OuroHandler.launch.selector;
        sel[14] = OuroHandler.seed.selector;
        sel[15] = OuroHandler.seed.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function invariant_supplyNeverExceedsCap() public view {
        assertLe(token.totalSupply(), token.CAP());
    }

    /// Only the sell tax removes supply: L2 burns from the pair what it mints.
    /// Until the pool is seeded, only the L1 allocation exists and the pair is
    /// empty; seeding adds the pool's tokens, at most the pool allocation.
    function invariant_supplyIsCapLessSellTax() public view {
        if (!mint.launched()) {
            assertEq(token.totalSupply(), 0);
            return;
        }
        if (!mint.poolSeeded()) {
            assertEq(token.totalSupply(), mint.L1_ALLOCATION());
            assertEq(pair.totalSupply(), 0);
            assertEq(token.balanceOf(address(pair)), 0);
            return;
        }
        assertLe(mint.seedTokens(), mint.POOL_ALLOCATION());
        assertEq(token.totalSupply(), mint.L1_ALLOCATION() + mint.seedTokens() - handler.sellBurned());
    }

    /// The mint contract always holds what it owes: unclaimed L1 allocations plus
    /// vesting, and until the pool is seeded, the L1 USDT for it.
    function invariant_mintIsSolvent() public view {
        if (!mint.launched()) return;
        assertGe(usdt.balanceOf(address(mint)), mint.l1Reserve() + mint.pendingQuote());
        uint256 owedL1;
        for (uint256 i; i < actors.length; ++i) {
            if (!mint.l1Claimed(actors[i])) owedL1 += mint.l1TokensOf(actors[i]);
        }
        for (uint256 i; i < seeders.length; ++i) {
            owedL1 += mint.l1TokensOf(seeders[i]);
        }
        assertGe(token.balanceOf(address(mint)), owedL1 + mint.totalVesting());
    }

    /// The bid book's USDT is exactly the sum of what bids still escrow.
    function invariant_bookEscrowMatches() public view {
        uint256 sum;
        uint256 next = book.nextBidId();
        for (uint256 id = 1; id < next; ++id) {
            (,, uint256 left) = book.bids(id);
            sum += left;
        }
        assertEq(usdt.balanceOf(address(book)), sum);
        assertEq(token.balanceOf(address(book)), 0);
    }

    /// Every L2 mint's tokens are in exactly one wallet's vest until claimed.
    function invariant_vestingAddsUp() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            (uint256 locked, uint256 claimable,) = mint.vestOf(actors[i]);
            sum += locked + claimable;
        }
        assertEq(sum, mint.totalVesting());
    }

    /// Quotas: nobody holds more than 30 shares.
    function invariant_quota() public view {
        for (uint256 i; i < actors.length; ++i) {
            assertLe(mint.walletShares(actors[i]), 30);
        }
    }

    /// Logged only; see foundry.toml on why this does not assert.
    function afterInvariant() public {
        emit log_named_uint("calls", handler.calls());
        emit log_named_uint("L1 mints", handler.okL1());
        emit log_named_uint("L2 mints", handler.okL2());
        emit log_named_uint("fills", handler.okFill());
        emit log_named_uint("swaps", handler.okSwap());
        emit log_named_uint("phase", uint256(mint.phase()));
    }

    /// Deterministic coverage: one pass through every phase must reach each action.
    function test_handlerReachesEveryPhase() public {
        for (uint256 i; i < 8; ++i) {
            handler.mintL1(i, 20, i % 2 == 0);
        }
        vm.warp(mint.l1End());
        handler.warp(1);
        assertTrue(mint.launched());
        for (uint256 i; i < 8; ++i) {
            handler.claimAll(i);
        }
        handler.placeBid(1, 50 ether, 1e9);
        handler.fill(2, 0, 50);
        assertEq(handler.okFill(), 1);
        vm.warp(mint.l2Start());
        handler.warp(1);
        assertFalse(mint.poolSeeded());
        handler.buy(0, 100 ether);
        assertEq(handler.okSwap(), 0);
        handler.mintL2(8, 1, false);
        assertEq(handler.okL2(), 0);
        handler.seed(0);
        for (uint256 i = 8; i < 12; ++i) {
            handler.mintL2(i, 30, i % 2 == 0);
        }
        assertTrue(mint.poolSeeded());
        assertEq(handler.okL2(), 4);
        handler.buy(0, 100 ether);
        handler.sell(0, 50);
        assertEq(handler.okSwap(), 2);
        invariant_supplyIsCapLessSellTax();
        invariant_mintIsSolvent();
        invariant_bookEscrowMatches();
    }
}
