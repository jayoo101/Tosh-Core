// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployOuroboros} from "../../script/DeployOuroboros.s.sol";
import {OuroborosToken} from "../../src/ouroboros/OuroborosToken.sol";
import {OuroborosMint} from "../../src/ouroboros/OuroborosMint.sol";
import {OuroborosBidBook} from "../../src/ouroboros/OuroborosBidBook.sol";
import {IPancakeV2Pair, IPancakeV2Router, IChainlinkFeed} from "../../src/ouroboros/interfaces/IOuroborosExternal.sol";
import {IAgentRegistry} from "../../src/libraries/AgentIdLib.sol";

interface ISafeView {
    function getOwners() external view returns (address[] memory);
}

interface IPancakeV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// @notice Rehearsal of `script/DeployOuroboros.s.sol` on a BSC mainnet fork,
///         through every phase on the live venues: L1 in USDT and in BNB at
///         the live Chainlink price, launch and L1 claims, the bid book, the
///         empty and closed pair through L1.5, foreign venues refused, the
///         project Safe's signers alone seeding the pool, L2 mints, and taxed
///         trades through the live PancakeSwap router. Skipped unless
///         `BSC_RPC` is set.
///
/// @dev    Agent IDs are mocked on the live registry, so the run does not
///         depend on any real holder.
contract ForkOuroborosBscTest is Test {
    address constant SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    uint256 constant PK = 0x0E0B0; // throwaway test key, holds nothing

    bool live;
    DeployOuroboros.Deployment d;
    address[] blocked;
    uint64 l1Start;
    uint64 l2Start;

    address alice = makeAddr("ouro-fork-alice");
    address bob = makeAddr("ouro-fork-bob");
    address carol = makeAddr("ouro-fork-carol");
    address dave = makeAddr("ouro-fork-dave");

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;

        DeployOuroboros script = new DeployOuroboros();
        blocked = script.blockedVenues();
        l1Start = uint64(block.timestamp + 1 hours);
        l2Start = l1Start + 2 hours + 1 days;
        vm.deal(vm.addr(PK), 1 ether);
        d = script.deploy(PK, SAFE, l1Start, l2Start);

        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i; i < users.length; ++i) {
            _setUp(users[i]);
        }
    }

    function _setUp(address w) internal {
        // Well-known test keys carry live 7702 delegations on BSC; a fresh label does not.
        require(w.code.length == 0, "test wallet has code on the fork");
        _giveId(w);
        deal(USDT, w, 10_000 ether);
        vm.deal(w, 10 ether);
        vm.startPrank(w);
        IERC20(USDT).approve(address(d.mint), type(uint256).max);
        IERC20(USDT).approve(address(d.book), type(uint256).max);
        IERC20(USDT).approve(ROUTER, type(uint256).max);
        IERC20(address(d.token)).approve(address(d.book), type(uint256).max);
        IERC20(address(d.token)).approve(ROUTER, type(uint256).max);
        vm.stopPrank();
    }

    function _giveId(address w) internal {
        string memory handle = string.concat(vm.toString(w), ".ai");
        vm.mockCall(REGISTRY, abi.encodeCall(IAgentRegistry.handleOf, (w)), abi.encode(handle));
        vm.mockCall(REGISTRY, abi.encodeCall(IAgentRegistry.ownerOfHandle, (handle)), abi.encode(w));
    }

    /// The fork's clock jumps; the live feed does not. Keep its answer, restamp it.
    function _freshFeed() internal {
        vm.clearMockedCalls();
        (, int256 answer,,,) = IChainlinkFeed(BNB_USD).latestRoundData();
        vm.mockCall(
            BNB_USD,
            abi.encodeWithSelector(IChainlinkFeed.latestRoundData.selector),
            abi.encode(uint80(1), answer, block.timestamp, block.timestamp, uint80(1))
        );
        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i; i < users.length; ++i) {
            _giveId(users[i]);
        }
        for (uint256 i; i < 20; ++i) {
            _giveId(address(uint160(0x5EED0000 + i)));
        }
    }

    function _reserves() internal view returns (uint256 u, uint256 t) {
        (uint112 r0, uint112 r1,) = IPancakeV2Pair(d.pair).getReserves();
        (t, u) = IPancakeV2Pair(d.pair).token0() == address(d.token)
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
    }

    function _swap(address who, address tokenIn, address tokenOut, uint256 amountIn) internal {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        vm.prank(who, who);
        IPancakeV2Router(ROUTER)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, who, block.timestamp);
    }

    function test_fork_ouroboros_wiredOnTheLiveChain() public {
        if (!live) return;
        assertEq(d.mint.owner(), SAFE);
        assertEq(d.token.minter(), address(d.mint));
        assertEq(d.token.pair(), d.pair);
        assertEq(d.token.tradingOpensAt(), l2Start);
        assertEq(d.token.treasury(), SAFE);
        assertEq(blocked.length, 4);
        for (uint256 i; i < blocked.length; ++i) {
            assertTrue(d.token.isBlockedVenue(blocked[i]));
        }
        address[] memory signers = ISafeView(SAFE).getOwners();
        for (uint256 i; i < signers.length; ++i) {
            assertTrue(d.mint.isSeeder(signers[i]));
        }
        assertTrue(d.mint.isSeeder(SAFE));
        assertFalse(d.mint.isSeeder(alice));
    }

    function test_fork_ouroboros_fullLifecycle() public {
        if (!live) return;

        // ── L1: 20 seeders and alice in USDT, bob in BNB at the live feed ──
        vm.warp(l1Start);
        _freshFeed();
        for (uint256 i; i < 20; ++i) {
            address s = address(uint160(0x5EED0000 + i));
            _setUp(s);
            vm.prank(s, s);
            d.mint.mintL1(30, type(uint256).max, bytes32(0));
        }
        vm.prank(alice, alice);
        d.mint.mintL1(30, type(uint256).max, bytes32(0));
        uint256 bnbIn = d.mint.quoteBnb(10 * 0.9 ether);
        uint256 bobBnb = bob.balance;
        vm.prank(bob, bob);
        d.mint.mintL1{value: bnbIn + 0.01 ether}(10, 0, bytes32(0));
        assertEq(bobBnb - bob.balance, bnbIn, "BNB refunded above the quote");
        assertEq(d.mint.totalL1Shares(), 640);

        // ── Launch: L1 tokens only, the pair stays empty and closed ──
        vm.warp(l1Start + 2 hours);
        d.mint.launch();
        assertEq(d.token.totalSupply(), d.mint.L1_ALLOCATION());
        assertEq(IERC20(USDT).balanceOf(address(d.mint)), 640 * 0.72 ether);
        vm.prank(alice);
        d.mint.claimL1();
        vm.prank(bob);
        d.mint.claimL1();
        uint256 aliceTokens = d.token.balanceOf(alice);
        assertEq(aliceTokens, d.mint.L1_ALLOCATION() * 30 / 640);

        vm.prank(alice);
        vm.expectRevert(OuroborosToken.TradingNotOpen.selector);
        IERC20(address(d.token)).transfer(d.pair, 1 ether);
        for (uint256 i; i < blocked.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(OuroborosToken.ForeignPair.selector);
            IERC20(address(d.token)).transfer(blocked[i], 1 ether);
        }
        address v3Pool = IPancakeV3Factory(PANCAKE_V3_FACTORY).createPool(address(d.token), USDT, 2500);
        vm.prank(alice);
        vm.expectRevert(OuroborosToken.ForeignPair.selector);
        IERC20(address(d.token)).transfer(v3Pool, 1 ether);

        // ── L1.5: the bid book is the market; 30 USDT clears 5 % of the 576 raised ──
        vm.prank(carol);
        uint256 id = d.book.placeBid(50 ether, 0.000001 ether);
        vm.prank(alice);
        d.book.fill(id, 30_000_000 ether, 0);
        assertEq(d.token.balanceOf(carol), 30_000_000 ether * 98 / 100);
        (uint256 l1Price, bool met) = d.mint.seedTerms();
        assertTrue(met);

        // ── L2: nothing until a Safe signer seeds the pool ──
        vm.warp(l2Start);
        vm.prank(carol);
        vm.expectRevert(OuroborosBidBook.MarketClosed.selector);
        d.book.fill(id, 1 ether, 0);
        vm.prank(dave, dave);
        vm.expectRevert(OuroborosMint.PoolNotSeeded.selector);
        d.mint.mintL2(30, type(uint256).max, 0, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(OuroborosMint.NotSeeder.selector);
        d.mint.seedPool(0);

        address signer = ISafeView(SAFE).getOwners()[0];
        vm.prank(signer);
        d.mint.seedPool(2 * l1Price);
        assertTrue(d.token.tradingOpen());
        (uint256 u, uint256 t) = _reserves();
        assertEq(u, 640 * 0.72 ether);
        assertEq(t, u * 1e18 / (2 * l1Price));
        assertEq(d.token.totalSupply(), d.mint.L1_ALLOCATION() + t);
        assertApproxEqRel(u * 1e18 / t, 2 * l1Price, 1e9, "seeded at twice par");
        uint256 seededSupply = d.token.totalSupply();

        // L2 in USDT, then in BNB with the feed refreshed to the new clock.
        (uint256 cost, uint256 quoted) = d.mint.quoteL2(30);
        vm.prank(dave, dave);
        d.mint.mintL2(30, cost, quoted * 99 / 100, bytes32(0));
        assertEq(d.token.totalSupply(), seededSupply, "equal burn");
        _freshFeed();
        (cost,) = d.mint.quoteL2(20);
        uint256 bnbL2 = d.mint.quoteBnb(cost) + 0.01 ether;
        vm.prank(bob, bob);
        d.mint.mintL2{value: bnbL2}(20, 0, 0, bytes32(0));

        vm.warp(block.timestamp + 180);
        vm.prank(dave);
        d.mint.claim();
        assertGt(d.token.balanceOf(dave), 0);

        // ── Taxed trades on the live router ──
        vm.roll(block.number + 1);
        _swap(carol, USDT, address(d.token), 5 ether);
        assertGt(d.token.balanceOf(address(d.token)), 0, "buy tax accrues");
        vm.roll(block.number + 1);
        uint256 supply = d.token.totalSupply();
        uint256 safeUsdt = IERC20(USDT).balanceOf(SAFE);
        uint256 sellAmt = d.token.balanceOf(dave);
        _swap(dave, address(d.token), USDT, sellAmt);
        assertEq(supply - d.token.totalSupply(), sellAmt / 100, "sell tax burned");
        assertGt(IERC20(USDT).balanceOf(SAFE), safeUsdt, "buy tax reaches the Safe as USDT");
    }
}
