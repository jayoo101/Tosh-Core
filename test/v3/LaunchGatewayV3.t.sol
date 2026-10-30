// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {MockSafeV3} from "./FactoryV2.t.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshLaunchGatewayV3} from "../../src/v3/ToshLaunchGatewayV3.sol";
import {ToshTokenV3 as ToshToken} from "../../src/v3/ToshTokenV3.sol";

/// @notice The permanent shelf halt, and the hand-over from the gateway it replaces.
contract LaunchGatewayV3Test is V2BaseV3 {
    ToshLaunchpadHookV3 hook;
    MockSafeV3 safe;
    ToshLaunchGatewayV3 gw;
    address signer;

    function setUp() public override {
        super.setUp();
        (, hook) = _create();

        safe = new MockSafeV3();
        signer = makeAddr("signer");
        safe.add(signer);

        // The production path: the old gateway owns the factory first.
        ToshLaunchGateway old = new ToshLaunchGateway(address(factory), address(safe));
        vm.prank(admin);
        factory.transferOwnership(address(old));
        safe.exec(address(old), abi.encodeCall(old.execute, (abi.encodeWithSignature("acceptOwnership()"))));

        gw = new ToshLaunchGatewayV3(address(factory), address(safe));
        safe.exec(address(old), abi.encodeCall(old.execute, (abi.encodeCall(factory.transferOwnership, (address(gw))))));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
    }

    function _exec(bytes memory data) internal {
        vm.prank(address(safe));
        gw.execute(data);
    }

    function _haltForever(address h) internal {
        vm.prank(address(safe));
        gw.haltForever(h);
    }

    // ─── hand-over ────────────────────────────────────────────────────────────

    function test_handover_keepsEverythingTheOldGatewayDid() public {
        assertEq(factory.owner(), address(gw));
        assertEq(gw.haltWindow(), factory.MAX_HALT_DURATION());
        assertTrue(gw.canLaunch(signer));
        assertEq(gw.getOwners()[0], signer);

        _exec(abi.encodeCall(ToshFactoryV3.pause, ()));
        assertTrue(factory.paused());
        _exec(abi.encodeCall(ToshFactoryV3.unpause, ()));

        vm.prank(signer);
        (, address h) = gw.createLaunch("Beta", "Beta", dev, fund, bytes32(0), HARD_CAP, AGENT_CAP, DURATION);
        assertTrue(factory.registeredHooks(h));
    }

    function test_beforeAnyPermanentHalt_ownershipCanStillMove() public {
        _exec(abi.encodeCall(factory.transferOwnership, (admin)));
        vm.prank(admin);
        factory.acceptOwnership();
        assertEq(factory.owner(), admin);
    }

    function test_revert_onlySafe() public {
        vm.prank(signer);
        vm.expectRevert(ToshLaunchGatewayV3.NotSafe.selector);
        gw.haltForever(address(hook));
        vm.prank(signer);
        vm.expectRevert(ToshLaunchGatewayV3.NotSafe.selector);
        gw.execute(abi.encodeCall(ToshFactoryV3.pause, ()));
    }

    function test_revert_zeroAddresses() public {
        vm.expectRevert(ToshLaunchGatewayV3.ZeroAddress.selector);
        new ToshLaunchGatewayV3(address(0), address(1));
        vm.expectRevert(ToshLaunchGatewayV3.ZeroAddress.selector);
        new ToshLaunchGatewayV3(address(factory), address(0));
    }

    // ─── haltForever ──────────────────────────────────────────────────────────

    function test_haltForever_haltsForAFullWindow() public {
        _haltForever(address(hook));
        assertTrue(gw.haltedForever(address(hook)));
        assertTrue(factory.ladderMintingHalted(address(hook)));
        assertEq(factory.hookLadderHaltedUntil(address(hook)), block.timestamp + gw.haltWindow());
        assertEq(gw.haltedHooks().length, 1);
    }

    function test_haltForever_blocksShelfMints() public {
        _haltForever(address(hook));
        vm.prank(address(hook));
        vm.expectRevert(ToshFactoryV3.LadderHalted.selector);
        factory.bookShelfMint(bob, 1e18);
    }

    function test_revert_haltForever_guards() public {
        vm.startPrank(address(safe));
        vm.expectRevert(ToshLaunchGatewayV3.HookNotRegistered.selector);
        gw.haltForever(trader);

        gw.haltForever(address(hook));
        vm.expectRevert(ToshLaunchGatewayV3.AlreadyHaltedForever.selector);
        gw.haltForever(address(hook));
        vm.stopPrank();
    }

    function test_revert_haltForever_whileOwnershipPending() public {
        (, ToshLaunchpadHookV3 h2) = _createAsGateway();
        _exec(abi.encodeCall(factory.transferOwnership, (admin)));
        vm.prank(address(safe));
        vm.expectRevert(ToshLaunchGatewayV3.OwnershipPending.selector);
        gw.haltForever(address(h2));
    }

    function test_revert_haltForever_whenNotOwner() public {
        _exec(abi.encodeCall(factory.transferOwnership, (admin)));
        vm.prank(admin);
        factory.acceptOwnership();
        vm.prank(address(safe));
        vm.expectRevert(ToshLaunchGatewayV3.NotFactoryOwner.selector);
        gw.haltForever(address(hook));
    }

    // ─── nothing can lift it ──────────────────────────────────────────────────

    function test_execute_refusesEveryWayToLiftOrShorten() public {
        _haltForever(address(hook));
        uint256 until = factory.hookLadderHaltedUntil(address(hook));

        vm.startPrank(address(safe));
        vm.expectRevert(ToshLaunchGatewayV3.HaltIsPermanent.selector);
        gw.execute(abi.encodeCall(ToshFactoryV3.resumeLadderMinting, (address(hook))));
        vm.expectRevert(ToshLaunchGatewayV3.HaltIsPermanent.selector);
        gw.execute(abi.encodeCall(ToshFactoryV3.haltLadderMinting, (address(hook), 1)));
        vm.expectRevert(ToshLaunchGatewayV3.OwnershipLocked.selector);
        gw.execute(abi.encodeCall(factory.transferOwnership, (admin)));
        vm.stopPrank();

        assertEq(factory.hookLadderHaltedUntil(address(hook)), until);
        assertEq(factory.owner(), address(gw));
    }

    function test_globalBrake_staysUsable_andCannotReopen() public {
        _haltForever(address(hook));
        _exec(abi.encodeCall(ToshFactoryV3.haltLadderMinting, (address(0), 1 hours)));
        _exec(abi.encodeCall(ToshFactoryV3.resumeLadderMinting, (address(0))));
        assertEq(factory.globalLadderHaltedUntil(), 0);
        assertTrue(factory.ladderMintingHalted(address(hook)), "the per-hook halt holds");
    }

    function test_otherProjects_keepTheirOrdinaryBrake() public {
        (, ToshLaunchpadHookV3 h2) = _createAsGateway();
        _haltForever(address(hook));
        _exec(abi.encodeCall(ToshFactoryV3.haltLadderMinting, (address(h2), 1 hours)));
        _exec(abi.encodeCall(ToshFactoryV3.resumeLadderMinting, (address(h2))));
        assertFalse(factory.ladderMintingHalted(address(h2)));
    }

    // ─── renewal ──────────────────────────────────────────────────────────────

    function test_renewHalt_anyoneExtends() public {
        _haltForever(address(hook));
        vm.warp(block.timestamp + 6 days);
        vm.prank(trader);
        gw.renewHalt(address(hook));
        assertEq(factory.hookLadderHaltedUntil(address(hook)), block.timestamp + gw.haltWindow());
    }

    function test_renewHalt_afterALapse_haltsAgain() public {
        _haltForever(address(hook));
        vm.warp(block.timestamp + gw.haltWindow() + 1);
        assertFalse(factory.ladderMintingHalted(address(hook)), "unrenewed, the factory halt lapses");
        vm.prank(trader);
        gw.renewHalt(address(hook));
        assertTrue(factory.ladderMintingHalted(address(hook)));
    }

    function test_renewAll_coversEveryHaltedHook() public {
        (, ToshLaunchpadHookV3 h2) = _createAsGateway();
        _haltForever(address(hook));
        _haltForever(address(h2));
        vm.warp(block.timestamp + 6 days);
        vm.prank(trader);
        gw.renewAll();
        assertEq(factory.hookLadderHaltedUntil(address(hook)), block.timestamp + gw.haltWindow());
        assertEq(factory.hookLadderHaltedUntil(address(h2)), block.timestamp + gw.haltWindow());
    }

    function test_revert_renewHalt_notHaltedForever() public {
        vm.expectRevert(ToshLaunchGatewayV3.NotHaltedForever.selector);
        gw.renewHalt(address(hook));
    }

    function _createAsGateway() internal returns (ToshToken token, ToshLaunchpadHookV3 h) {
        vm.prank(address(safe));
        (address t, address hh) = gw.createLaunch("Beta", "Beta", dev, fund, bytes32(0), HARD_CAP, AGENT_CAP, DURATION);
        return (ToshToken(t), ToshLaunchpadHookV3(payable(hh)));
    }
}
