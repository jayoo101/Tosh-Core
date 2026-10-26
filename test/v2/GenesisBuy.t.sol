// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2Base} from "./utils/V2Base.sol";
import {MockAgentRegistry} from "./utils/MockAgentRegistry.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshFactory} from "../../src/ToshFactory.sol";
import {ToshHookLens} from "../../src/ToshHookLens.sol";
import {AgentIdLib} from "../../src/libraries/AgentIdLib.sol";
import {GenesisCurve} from "../../src/libraries/GenesisCurve.sol";
import {MockERC20} from "../utils/MockERC20.sol";

contract AcceptsNative {
    receive() external payable {}
}

contract ReentersOnNative {
    receive() external payable {
        ToshLaunchpadHook(payable(msg.sender)).buyGenesis(1e18, 0);
    }
}

contract GenesisBuyTest is V2Base {
    ToshToken token;
    ToshLaunchpadHook hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
    }

    function test_buy_mintsImmediatelyAndSplitsFunds() public {
        uint256 before = quote.balanceOf(alice);
        (uint256 tokens, uint256 cost) = _buy(hook, alice, 1e18);

        assertGt(tokens, 0);
        assertLe(cost, 1e18);
        assertEq(token.balanceOf(alice), tokens, "delivered now");
        assertTrue(token.isReceiver(alice), "buyer registered");
        assertEq(before - quote.balanceOf(alice), cost);
        assertEq(hook.genesisSold(), tokens);
        assertEq(hook.raised(), cost);
        assertEq(hook.fundAccrued(), cost * 2000 / 10_000);
        assertEq(hook.lpReserve(), cost - cost * 2000 / 10_000);
        assertEq(quote.balanceOf(address(hook)), cost);
        assertEq(GenesisCurve.costOf(HARD_CAP, 0, tokens), cost, "pays exact curve cost");
    }

    function test_price_risesLinearlyFromPto1_5P() public {
        uint256 p = lens.basePrice(address(hook));
        assertEq(hook.currentGenesisPrice(), p);
        assertApproxEqRel(p, HARD_CAP * 1e18 / 7_000_000e18, 1e9);
        _sellOut(hook);
        assertApproxEqRel(hook.currentGenesisPrice(), p * 3 / 2, 1e12, "ends at 1.5P");
        assertApproxEqAbs(hook.raised(), HARD_CAP, 1e6, "raises the hard cap");
    }

    function test_laterBuyersPayMore() public {
        (uint256 t1,) = _buy(hook, alice, 1e18);
        (uint256 t2,) = _buy(hook, bob, 1e18);
        assertGt(t1, t2);
    }

    function test_revert_noAgentId() public {
        vm.prank(dave, dave);
        vm.expectRevert(ToshLaunchpadHook.NoAgentId.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_revert_notTxOrigin() public {
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHook.NotAWallet.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_delegatedEoa_canBuy() public {
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        (uint256 tokens,) = _buy(hook, alice, 1e18);
        assertGt(tokens, 0);
        assertEq(token.balanceOf(alice), tokens);
        assertTrue(token.isReceiver(alice));
    }

    function test_agentCap_clampsAndThenStops() public {
        (, uint256 cost) = _buy(hook, alice, 100e18);
        assertApproxEqAbs(cost, AGENT_CAP, 2, "clamped to cap");
        uint256 rem = AGENT_CAP - cost;
        if (rem == 0) {
            vm.prank(alice, alice);
            vm.expectRevert(ToshLaunchpadHook.AgentCapReached.selector);
            hook.buyGenesis(1e18, 0);
        }
        ToshHookLens.AccountState memory a = lens.accountState(address(hook), alice);
        assertTrue(a.registryOk);
        assertEq(a.remaining, rem);
    }

    function test_agentCap_followsTheHandleNotTheAddress() public {
        _buy(hook, alice, 3e18);
        address alice2 = makeAddr("alice2");
        quote.mint(alice2, 100e18);
        vm.prank(alice2);
        quote.approve(address(hook), type(uint256).max);
        registry.setHandle(alice2, "alice"); // handle moved

        (, uint256 cost) = _buy(hook, alice2, 10e18);
        assertApproxEqAbs(cost, 2e18, 2, "only the rest of the cap");

        // The old address now has no matching owner.
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.NoAgentId.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_revert_staleReverseRecord() public {
        registry.setOwnerOnly("alice", bob);
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.NoAgentId.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_minBuy() public {
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.BelowMinBuy.selector);
        hook.buyGenesis(MIN_BUY - 1, 0);
        _buy(hook, alice, MIN_BUY);
    }

    function test_minBuy_waivedForTheLastOfAnAllowance() public {
        (, uint256 cost) = _buy(hook, alice, AGENT_CAP - MIN_BUY / 2);
        uint256 rem = AGENT_CAP - cost;
        assertLt(rem, MIN_BUY);
        (, uint256 cost2) = _buy(hook, alice, rem);
        assertLe(cost2, rem);
    }

    function test_slippage() public {
        (uint256 expect,) = lens.quoteGenesis(address(hook), 1e18);
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.BelowMinTokens.selector);
        hook.buyGenesis(1e18, expect + 1);
        vm.prank(alice, alice);
        (uint256 got,) = hook.buyGenesis(1e18, expect);
        assertEq(got, expect);
    }

    function test_native_wrapsAndRefundsChange() public {
        uint256 ethBefore = alice.balance;
        uint256 quoteBefore = quote.balanceOf(alice);
        vm.prank(alice, alice);
        (, uint256 cost) = hook.buyGenesis{value: 100 ether}(100 ether, 0);
        assertApproxEqAbs(cost, AGENT_CAP, 2);
        assertEq(ethBefore - alice.balance, cost, "change returned");
        assertEq(quote.balanceOf(alice), quoteBefore, "no ERC20 pulled");
        assertEq(quote.balanceOf(address(hook)), cost, "wrapped");
    }

    function test_native_delegatedBuyerGetsChange() public {
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(new AcceptsNative())));
        uint256 ethBefore = alice.balance;
        vm.prank(alice, alice);
        (, uint256 cost) = hook.buyGenesis{value: 100 ether}(100 ether, 0);
        assertEq(ethBefore - alice.balance, cost, "change returned");
    }

    function test_revert_native_delegatedBuyerReentersOnChange() public {
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(new ReentersOnNative())));
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.NativeTransferFailed.selector);
        hook.buyGenesis{value: 100 ether}(100 ether, 0);
    }

    function test_revert_nativeAmountMismatch() public {
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.NativeAmountMismatch.selector);
        hook.buyGenesis{value: 1 ether}(2 ether, 0);
    }

    function test_revert_nativeOnErc20Stack() public {
        MockERC20 usdt = new MockERC20("USDT", "USDT");
        vm.startPrank(admin);
        ToshFactory usdtFactory = _deployFactory(address(usdt), 5e18, false);
        (, address hk) = usdtFactory.createLaunch("U", "U", dev, fund, bytes32(0), 10_000e18, 500e18, DURATION);
        vm.stopPrank();

        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.NativeNotAccepted.selector);
        ToshLaunchpadHook(payable(hk)).buyGenesis{value: 1 ether}(1 ether, 0);

        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.BelowMinBuy.selector);
        ToshLaunchpadHook(payable(hk)).buyGenesis(4e18, 0);
    }

    function test_soldOut_closesAndFreezesPrice() public {
        _sellOut(hook);
        assertGt(hook.soldOutAt(), 0);
        assertGe(hook.genesisSold() + hook.DUST(), hook.SALE_SUPPLY());
        uint256 frozen = hook.currentGenesisPrice();
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.GenesisSoldOut.selector);
        hook.buyGenesis(1e18, 0);
        assertEq(hook.currentGenesisPrice(), frozen);
    }

    function test_revert_afterDeadline() public {
        vm.warp(hook.genesisDeadline());
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.GenesisExpired.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_registryFailure_revertsBuy() public {
        registry.setMode(MockAgentRegistry.Mode.Revert);
        vm.prank(alice, alice);
        vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
        hook.buyGenesis(1e18, 0);

        ToshHookLens.AccountState memory a = lens.accountState(address(hook), alice);
        assertFalse(a.registryOk);
    }

    function test_genesisPause_andBlacklist() public {
        vm.prank(admin);
        factory.setGenesisPaused(address(hook), true);
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.GenesisPaused.selector);
        hook.buyGenesis(1e18, 0);

        vm.prank(admin);
        factory.setGenesisPaused(address(hook), false);
        address[] memory u = new address[](1);
        u[0] = alice;
        vm.prank(admin);
        factory.setBlacklist(u, 1 days);
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.GenesisPaused.selector);
        hook.buyGenesis(1e18, 0);
        _buy(hook, bob, 1e18);
    }

    function testFuzz_buys_neverOverchargeAndConserve(uint96[6] memory pays) public {
        address[3] memory who = [alice, bob, carol];
        uint256 total;
        for (uint256 i; i < pays.length; ++i) {
            uint256 pay = bound(uint256(pays[i]), MIN_BUY, 6e18);
            vm.prank(who[i % 3], who[i % 3]);
            try hook.buyGenesis(pay, 0) returns (uint256, uint256 cost) {
                assertLe(cost, pay);
                total += cost;
            } catch {}
        }
        assertEq(hook.raised(), total);
        assertEq(quote.balanceOf(address(hook)), total);
        assertEq(hook.fundAccrued() + hook.lpReserve(), total);
        assertEq(token.totalSupply(), hook.genesisSold());
        assertGe(GenesisCurve.costOf(HARD_CAP, 0, hook.genesisSold()), 0);
        assertLe(hook.raised(), GenesisCurve.costOf(HARD_CAP, 0, hook.genesisSold()) + 6);
    }
}
