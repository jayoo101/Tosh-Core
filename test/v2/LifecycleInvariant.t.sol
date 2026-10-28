// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshToken} from "../../src/ToshToken.sol";

/// @dev Drives one project through genesis, launch and trading in random order.
contract LifecycleHandler is Test {
    ToshLaunchpadHook public hook;
    ToshToken public token;
    ToshLadderTreasury ladder;
    CLPoolManagerRouter router;
    address dev;
    address[] public actors;

    uint256 public buys;
    uint256 public launches;
    uint256 public swaps;
    uint256 public mints;

    constructor(
        ToshLaunchpadHook h,
        ToshToken t,
        ToshLadderTreasury l,
        CLPoolManagerRouter r,
        address dev_,
        address[] memory a
    ) {
        (hook, token, ladder, router, dev, actors) = (h, t, l, r, dev_, a);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _roll() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
    }

    function buy(uint256 who, uint256 pay) external {
        if (hook.launched()) return;
        address a = _actor(who);
        pay = bound(pay, hook.minBuy(), 6e18);
        vm.prank(a, a);
        try hook.buyGenesis(pay, 0) {
            ++buys;
        } catch {}
    }

    function wait(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 12 hours));
        vm.roll(block.number + 1);
    }

    function launch() external {
        if (hook.launched()) return;
        if (block.timestamp < hook.launchStart()) return;
        vm.prank(dev);
        try hook.launch() {
            ++launches;
        } catch {}
    }

    function swap(uint256 who, bool isBuy, uint256 amount) external {
        if (!hook.launched()) return;
        _roll();
        address a = _actor(who);
        PoolKey memory key = hook.getPoolKey();
        if (isBuy) {
            amount = bound(amount, 1e12, 3e18);
        } else {
            uint256 bal = token.balanceOf(a);
            if (bal < 1e12) return;
            amount = bound(amount, 1e12, bal);
            vm.prank(a);
            token.approve(address(router), type(uint256).max);
        }
        vm.prank(a);
        try router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        ) {
            ++swaps;
        } catch {}
    }

    function mintShelf(uint256 who, uint256 amount) external {
        if (!hook.launched()) return;
        _roll();
        uint256 max = hook.maxMintable();
        if (max < 1e18) return;
        amount = bound(amount, 1e18, max);
        address a = _actor(who);
        uint256 cost = hook.quoteMint(amount);
        vm.prank(a, a);
        try hook.mintBondingCurve(amount, cost) {
            ++mints;
        } catch {}
    }

    function poke() external {
        try ladder.pokeBuyback() {} catch {}
    }

    function withdrawFund() external {
        vm.prank(dev);
        try hook.withdrawFund() {} catch {}
    }

    function transfer(uint256 from, uint256 to, uint256 amount) external {
        address a = _actor(from);
        address b = _actor(to);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a, a);
        try token.transfer(b, amount) {} catch {}
    }
}

/// @notice Properties that must hold at every step of a project's life.
contract LifecycleInvariantTest is V2Base {
    LifecycleHandler handler;
    ToshLaunchpadHook hook;
    ToshToken token;

    function setUp() public override {
        super.setUp();
        // A small raise, so three Agent IDs can sell it out and the run reaches
        // both the sold-out and the partial-raise launch.
        (token, hook) = _create("Inv", 10e18, 4e18);
        // Seeded so a run that waits out genesis first still launches.
        _buy(hook, alice, 1e18);
        address[] memory a = new address[](4);
        (a[0], a[1], a[2], a[3]) = (alice, bob, carol, dave);
        handler = new LifecycleHandler(hook, token, ladder, router, dev, a);
        targetContract(address(handler));
    }

    function invariant_supplyIsAccountedFor() public view {
        uint256 supply = token.totalSupply();
        assertLe(supply, token.MAX_SUPPLY());
        if (hook.launched()) {
            assertEq(supply, hook.GENESIS_SUPPLY() + hook.phase2Minted(), "8.4M at launch plus shelves");
        } else {
            assertEq(supply, hook.genesisSold(), "before launch only what genesis sold exists");
        }
    }

    function invariant_genesisStaysInsideItsCaps() public view {
        // Each buy's cost rounds up, so a raise split into n buys may overshoot
        // the cap by at most n wei; the +1 is the buy seeded in setUp.
        assertLe(hook.raised(), hook.hardCap() + handler.buys() + 1);
        assertLe(hook.genesisSold(), hook.SALE_SUPPLY());
        for (uint256 i; i < handler.actorCount(); ++i) {
            assertLe(lens.accountState(address(hook), handler.actors(i)).spent, hook.perAgentCap());
        }
    }

    function invariant_hookHoldsExactlyWhatItOwes() public view {
        uint256 bal = quote.balanceOf(address(hook));
        if (hook.launched()) {
            assertEq(bal, hook.fundAccrued(), "after launch only the unwithdrawn fund stays");
        } else {
            assertEq(bal + hook.fundWithdrawn(), hook.raised(), "before launch the raise is all here");
        }
        assertLe(hook.fundAccrued() + hook.fundWithdrawn(), hook.raised() * hook.FUND_BPS() / 10_000);
    }

    function invariant_noTokenReachesAContractBeforeLaunch() public view {
        assertEq(token.tradingOpen(), hook.launched());
        if (hook.launched()) return;
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(address(router)), 0);
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            if (token.balanceOf(a) > 0) assertTrue(token.isReceiver(a), "holders are registered");
        }
    }

    function invariant_buybackFlagNeverLeaks() public view {
        assertFalse(ladder.piggybackActive());
    }
}
