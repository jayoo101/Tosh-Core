// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";

contract Relay {
    function push(ToshToken t, address to, uint256 v) external {
        t.transfer(to, v);
    }

    function pull(ToshToken t, address from, address to, uint256 v) external {
        t.transferFrom(from, to, v);
    }

    function register(ToshToken t) external {
        t.registerReceiver();
    }
}

contract TokenTransferRulesTest is V2Base {
    ToshToken token;
    ToshLaunchpadHook hook;
    Relay relay;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 1e18);
        _buy(hook, bob, 1e18);
        relay = new Relay();
    }

    function test_walletToRegisteredWallet() public {
        vm.prank(alice, alice);
        token.transfer(bob, 1e18);
        assertEq(token.balanceOf(bob) > 1e18, true);
    }

    function test_revert_unregisteredReceiver_thenRegister() public {
        vm.prank(alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ToshToken.ReceiverNotRegistered.selector, dave));
        token.transfer(dave, 1e18);

        vm.prank(dave, dave);
        token.registerReceiver();
        vm.prank(alice, alice);
        token.transfer(dave, 1e18);
        assertEq(token.balanceOf(dave), 1e18);
    }

    function test_revert_toContract() public {
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(address(relay), 1e18);
    }

    function test_revert_fromDelegatedEoa() public {
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(relay)));
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(bob, 1e18);
    }

    function test_revert_toDelegatedEoa() public {
        vm.etch(bob, abi.encodePacked(hex"ef0100", address(relay)));
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(bob, 1e18);
    }

    function test_revert_notOrigin() public {
        vm.prank(alice, bob);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(bob, 1e18);
    }

    function test_revert_approveAnyoneButTheBook() public {
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.ApprovalRestricted.selector);
        token.approve(address(relay), 1e18);
        vm.prank(alice, alice);
        token.approve(address(book), 1e18);
        assertEq(token.allowance(alice, address(book)), 1e18);
    }

    function test_revert_registerFromContract() public {
        vm.expectRevert(ToshToken.NotAWallet.selector);
        relay.register(token);
    }

    function test_revert_registerForOnlyRegistrars() public {
        vm.prank(alice);
        vm.expectRevert(ToshToken.OnlyRegistrar.selector);
        token.registerFor(dave);
        vm.prank(address(book));
        token.registerFor(dave);
        assertTrue(token.isReceiver(dave));
    }

    function test_revert_openTradingOnlyHook() public {
        vm.expectRevert(ToshToken.OnlyHook.selector);
        token.openTrading();
    }

    function test_afterLaunch_plainErc20() public {
        _launchAsAdmin(hook);
        assertTrue(token.tradingOpen());
        vm.prank(alice);
        token.transfer(address(relay), 1e18);
        vm.prank(alice);
        token.approve(address(relay), 1e18);
        relay.pull(token, alice, trader, 1e18);
        relay.push(token, dave, 1e18);
        assertEq(token.balanceOf(dave), 1e18);
        assertEq(token.balanceOf(trader), 1e18);
    }
}
