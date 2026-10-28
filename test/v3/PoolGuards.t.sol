// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";

/// @dev A Uniswap-v2-shaped pair: liquidity arrives as plain transfers into it,
///      and `mint` would credit whatever balance it finds.
contract MiniPairV3 {
    function pull(IERC20 t, address from, uint256 v) external {
        t.transferFrom(from, address(this), v);
    }
}

/// @dev The code a 7702-delegated "desk" would run: anyone may call it, and it
///      tries to pay out the tokens it holds.
contract DeskCodeV3 {
    function payOut(ToshToken t, address to, uint256 v) external {
        t.transfer(to, v);
    }
}

/// @notice Who may open, fund or drain a pool for a project token, before and
///         after launch, on our pool and on any other.
contract PoolGuardsTestV3 is V2BaseV3 {
    using PoolIdLibrary for PoolKey;
    using CLPoolParametersHelper for bytes32;

    int24 constant FULL_LOWER = -887200;
    int24 constant FULL_UPPER = 887200;

    ToshToken token;
    ToshLaunchpadHookV3 hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
    }

    function _hookless() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(quote)),
            currency1: Currency.wrap(address(token)),
            hooks: IHooks(address(0)),
            poolManager: IPoolManager(address(poolManager)),
            fee: 3000,
            parameters: bytes32(0).setTickSpacing(60)
        });
    }

    function _addLiquidity(PoolKey memory key, address who, int256 delta) internal {
        vm.prank(who);
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: FULL_LOWER, tickUpper: FULL_UPPER, liquidityDelta: delta, salt: bytes32(0)
            }),
            ""
        );
    }

    // ─── before launch ────────────────────────────────────────────────────────

    function test_revert_preLaunch_nobodyElseOpensOurPool() public {
        PoolKey memory key = hook.getPoolKey();
        vm.prank(trader);
        vm.expectRevert();
        poolManager.initialize(key, TickMath.getSqrtRatioAtTick(0));
    }

    function test_preLaunch_aRivalPoolCanBeOpenedButNeverFunded() public {
        PoolKey memory key = _hookless();
        // Opening needs no tokens, so nothing stops it...
        poolManager.initialize(key, TickMath.getSqrtRatioAtTick(0));

        // ...but every way of getting the token into the Vault is shut.
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.ApprovalRestricted.selector);
        token.approve(address(router), type(uint256).max);

        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(address(vault), 1e18);

        vm.expectRevert();
        _addLiquidity(key, alice, 1e18);

        assertEq(poolManager.getLiquidity(key.toId()), 0, "the rival pool stays empty");
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_revert_preLaunch_v2ShapedPairCannotBeSeeded() public {
        MiniPairV3 pair = new MiniPairV3();
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(address(pair), 1e18);

        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.ApprovalRestricted.selector);
        token.approve(address(pair), 1e18);

        // Even the one allowance that is possible, to the bid book, cannot be
        // spent by anyone else.
        vm.prank(alice, alice);
        token.approve(address(book), 1e18);
        vm.prank(alice, alice);
        vm.expectRevert();
        pair.pull(token, alice, 1e18);
    }

    function test_preLaunch_a7702DeskCanBuyButNeverSell() public {
        address desk = makeAddr("desk");
        DeskCodeV3 code = new DeskCodeV3();
        vm.etch(desk, abi.encodePacked(hex"ef0100", address(code)));
        vm.prank(desk, desk);
        token.registerReceiver();

        vm.prank(alice, alice);
        token.transfer(desk, 1e18);
        assertEq(token.balanceOf(desk), 1e18, "a delegated wallet can receive");

        // A buyer calling the desk's code is the origin, not the desk.
        vm.prank(bob, bob);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        DeskCodeV3(desk).payOut(token, bob, 1e18);

        // Only the desk's own transaction moves its tokens.
        vm.prank(desk, desk);
        DeskCodeV3(desk).payOut(token, bob, 1e18);
        assertEq(token.balanceOf(desk), 0);
    }

    // ─── after launch ─────────────────────────────────────────────────────────

    function test_revert_afterLaunch_ourPoolCannotBeReopened() public {
        _launchAsAdmin(hook);
        PoolKey memory key = hook.getPoolKey();
        vm.prank(trader);
        vm.expectRevert();
        poolManager.initialize(key, TickMath.getSqrtRatioAtTick(0));
    }

    function test_afterLaunch_thirdPartyLpComesAndGoes_genesisPositionStays() public {
        _launchAsAdmin(hook);
        _nextBlock();
        _swapBuy(hook, trader, 2e18);
        PoolKey memory key = hook.getPoolKey();
        PoolId id = key.toId();
        uint128 genesisL = poolManager.getLiquidity(id, address(hook), FULL_LOWER, FULL_UPPER, bytes32(0));
        assertGt(genesisL, 0);

        vm.prank(trader);
        token.approve(address(router), type(uint256).max);
        uint128 before = poolManager.getLiquidity(id);
        _addLiquidity(key, trader, 1e18);
        assertEq(poolManager.getLiquidity(id), before + 1e18, "anyone may add after launch");

        _addLiquidity(key, trader, -1e18);
        assertEq(poolManager.getLiquidity(id), before, "and withdraw their own");

        // Positions are keyed by the caller, so nobody can address the hook's.
        vm.expectRevert();
        _addLiquidity(key, trader, -1);
        assertEq(
            poolManager.getLiquidity(id, address(hook), FULL_LOWER, FULL_UPPER, bytes32(0)),
            genesisL,
            "genesis liquidity untouched"
        );
    }

    function test_afterLaunch_donationReachesTheCircuitVault() public {
        _launchAsAdmin(hook);
        _nextBlock();
        PoolKey memory key = hook.getPoolKey();
        vm.prank(trader);
        router.donate(key, 1e18, 0, "");
        uint256 before = quote.balanceOf(hook.projectAdmin());
        hook.collectGenesisFees();
        assertApproxEqRel(quote.balanceOf(hook.projectAdmin()) - before, 1e18, 1e15, "genesis LP owns ~all of it");
    }

    function test_revert_hookCallbacksOnlyFromTheManager() public {
        PoolKey memory key = hook.getPoolKey();
        vm.expectRevert(ToshLaunchpadHookV3.OnlyPoolManager.selector);
        hook.beforeInitialize(address(this), key, 0);
        vm.expectRevert(ToshLaunchpadHookV3.OnlyPoolManager.selector);
        hook.beforeSwap(
            address(this),
            key,
            ICLPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0}),
            ""
        );
        vm.expectRevert(ToshLaunchpadHookV3.OnlyVault.selector);
        hook.lockAcquired(abi.encode(uint8(2)));
    }

    function test_revert_unknownLockAction() public {
        vm.prank(address(vault));
        vm.expectRevert(ToshLaunchpadHookV3.UnknownAction.selector);
        hook.lockAcquired(abi.encode(uint8(9)));
    }
}
