// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {AgentIdLib} from "../../src/libraries/AgentIdLib.sol";
import {MockAgentRegistryV3} from "./utils/MockAgentRegistryV3.sol";

/// @notice Shelf minting needs an Agent ID, and each ID has a lifetime quote
///         allowance per project, separate from its genesis allowance.
contract ShelfGateTestV3 is V2BaseV3 {
    ToshToken internal token;
    ToshLaunchpadHookV3 internal hook;

    event ShelfCapSet(uint256 cap);

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        _launchAsAdmin(hook);
        _nextBlock();
        _swapBuy(hook, trader, 0.1e18);
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
    }

    function _amount() internal view returns (uint256) {
        return hook.tierSize();
    }

    function _mint(address who, uint256 amount) internal returns (uint256 cost) {
        cost = lens.quoteMint(address(hook), amount);
        vm.prank(who, who);
        hook.mintBondingCurve(amount, cost);
        _nextBlock();
    }

    function _setCap(uint256 cap) internal {
        vm.prank(admin);
        factory.setShelfCapPerAgent(cap);
    }

    function _key(string memory handle) internal pure returns (bytes32) {
        return keccak256(bytes(handle));
    }

    function test_shelfGate_noAgentId_reverts() public {
        uint256 amount = _amount();
        uint256 cost = lens.quoteMint(address(hook), amount);
        vm.prank(dave, dave);
        vm.expectRevert(ToshFactoryV3.NoAgentId.selector);
        hook.mintBondingCurve(amount, cost);
        assertEq(factory.shelfRemaining(address(hook), dave), 0);
    }

    function test_shelfGate_genesisSpendDoesNotCount() public view {
        assertEq(factory.shelfCapPerAgent(), SHELF_CAP);
        assertEq(factory.shelfRemaining(address(hook), bob), SHELF_CAP, "bob bought genesis, shelf starts at zero");
    }

    function test_shelfGate_booksAgainstIdAndWallet() public {
        uint256 cost = _mint(bob, _amount());
        assertGt(cost, 0);
        assertEq(factory.shelfSpentByAgent(address(hook), _key("bob")), cost);
        assertEq(factory.shelfSpentByWallet(address(hook), bob), cost);
        assertEq(factory.shelfRemaining(address(hook), bob), SHELF_CAP - cost);
    }

    function test_shelfGate_capExceeded_noPartialFill() public {
        uint256 cost = lens.quoteMint(address(hook), _amount());
        _setCap(cost);
        _mint(bob, _amount());
        assertEq(factory.shelfRemaining(address(hook), bob), 0);

        uint256 next = lens.quoteMint(address(hook), 1e18);
        vm.prank(bob, bob);
        vm.expectRevert(ToshFactoryV3.ShelfCapExceeded.selector);
        hook.mintBondingCurve(1e18, next);

        // The allowance is the ID's, not the wallet's: carol is untouched.
        _mint(carol, _amount() / 2);
    }

    function test_shelfGate_newHandleKeepsTheWalletSpend() public {
        _setCap(lens.quoteMint(address(hook), _amount()));
        _mint(bob, _amount());

        registry.setHandle(bob, "bob2");
        uint256 next = lens.quoteMint(address(hook), 1e18);
        vm.prank(bob, bob);
        vm.expectRevert(ToshFactoryV3.ShelfCapExceeded.selector);
        hook.mintBondingCurve(1e18, next);
    }

    function test_shelfGate_movedHandleKeepsTheIdSpend() public {
        _setCap(lens.quoteMint(address(hook), _amount()));
        _mint(bob, _amount());

        registry.setHandle(dave, "bob");
        assertEq(factory.shelfRemaining(address(hook), dave), 0);
        uint256 next = lens.quoteMint(address(hook), 1e18);
        vm.prank(dave, dave);
        vm.expectRevert(ToshFactoryV3.ShelfCapExceeded.selector);
        hook.mintBondingCurve(1e18, next);
    }

    function test_shelfGate_allowanceIsPerProject() public {
        (, ToshLaunchpadHookV3 h2) = _create("Second", HARD_CAP, AGENT_CAP);
        uint256 cost = _mint(bob, _amount());
        assertEq(factory.shelfRemaining(address(hook), bob), SHELF_CAP - cost);
        assertEq(factory.shelfRemaining(address(h2), bob), SHELF_CAP);
    }

    function test_shelfGate_capChangeAppliesAtOnce() public {
        uint256 cost = _mint(bob, _amount());
        _setCap(cost);
        assertEq(factory.shelfRemaining(address(hook), bob), 0, "lowered below the spend");

        _setCap(SHELF_CAP);
        assertEq(factory.shelfRemaining(address(hook), bob), SHELF_CAP - cost, "raised again");
        _mint(bob, _amount());
    }

    function test_shelfGate_setter_ownerOnlyAndBounded() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        factory.setShelfCapPerAgent(1e18);

        vm.prank(admin);
        vm.expectRevert(ToshFactoryV3.InvalidShelfCap.selector);
        factory.setShelfCapPerAgent(MIN_BUY - 1);

        vm.prank(admin);
        vm.expectRevert(ToshFactoryV3.InvalidShelfCap.selector);
        factory.setShelfCapPerAgent(uint256(type(uint128).max) + 1);

        vm.expectEmit(address(factory));
        emit ShelfCapSet(700e18);
        _setCap(700e18);
        assertEq(factory.shelfCapPerAgent(), 700e18);
    }

    function test_shelfGate_onlyRegisteredHooksBook() public {
        vm.prank(bob);
        vm.expectRevert(ToshFactoryV3.HookNotRegistered.selector);
        factory.bookShelfMint(bob, 1);
    }

    function test_shelfGate_registryFailure_revertsMint() public {
        uint256 amount = _amount();
        uint256 cost = lens.quoteMint(address(hook), amount);
        registry.setMode(MockAgentRegistryV3.Mode.Revert);
        vm.prank(bob, bob);
        vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
        hook.mintBondingCurve(amount, cost);
    }
}
