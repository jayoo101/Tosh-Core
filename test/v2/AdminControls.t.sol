// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {V2Base} from "./utils/V2Base.sol";
import {MockSafe} from "./FactoryV2.t.sol";
import {ToshFactory} from "../../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshToken} from "../../src/ToshToken.sol";

/// @notice The platform's brakes and the read-only helpers around them.
contract AdminControlsTest is V2Base {
    ToshToken token;
    ToshLaunchpadHook hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
    }

    function _one(address a) internal pure returns (address[] memory u) {
        u = new address[](1);
        u[0] = a;
    }

    // ─── factory brakes ───────────────────────────────────────────────────────

    function test_unpause_resumesListing() public {
        vm.startPrank(admin);
        factory.pause();
        factory.unpause();
        vm.stopPrank();
        uint256 n = factory.launchCount();
        _create("Beta", HARD_CAP, AGENT_CAP);
        assertEq(factory.launchCount(), n + 1);
    }

    function test_revert_brakesAreOwnerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader);
        vm.startPrank(trader);
        vm.expectRevert(unauthorized);
        factory.pause();
        vm.expectRevert(unauthorized);
        factory.unpause();
        vm.expectRevert(unauthorized);
        factory.setGenesisPaused(address(0), true);
        vm.expectRevert(unauthorized);
        factory.setBlacklist(_one(alice), 1 days);
        vm.expectRevert(unauthorized);
        factory.liftBlacklist(_one(alice));
        vm.expectRevert(unauthorized);
        factory.resumeLadderMinting(address(0));
        vm.expectRevert(unauthorized);
        factory.setHardCapBounds(1e18, 2e18);
        vm.expectRevert(unauthorized);
        factory.setAgentCapBounds(MIN_BUY, 1e18);
        vm.stopPrank();
    }

    function test_globalGenesisPause_coversEveryProject() public {
        (, ToshLaunchpadHook h2) = _create("Beta", HARD_CAP, AGENT_CAP);
        vm.prank(admin);
        factory.setGenesisPaused(address(0), true);
        assertTrue(factory.genesisBlocked(address(hook), alice));
        assertTrue(factory.genesisBlocked(address(h2), alice));
        vm.prank(alice, alice);
        vm.expectRevert(ToshLaunchpadHook.GenesisPaused.selector);
        h2.buyGenesis(1e18, 0);

        vm.prank(admin);
        factory.setGenesisPaused(address(0), false);
        _buy(h2, alice, 1e18);
    }

    function test_blacklist_expires_liftable_andPermanent() public {
        vm.prank(admin);
        factory.setBlacklist(_one(alice), 1 hours);
        assertTrue(factory.genesisBlocked(address(hook), alice));
        vm.warp(block.timestamp + 1 hours);
        assertFalse(factory.genesisBlocked(address(hook), alice), "a timed ban lapses");

        vm.prank(admin);
        factory.setBlacklist(_one(alice), type(uint256).max);
        vm.warp(block.timestamp + 3650 days);
        assertTrue(factory.genesisBlocked(address(hook), alice), "max is permanent");

        vm.prank(admin);
        factory.liftBlacklist(_one(alice));
        assertFalse(factory.genesisBlocked(address(hook), alice));
    }

    function test_revert_blacklist_batchLimit() public {
        address[] memory many = new address[](201);
        vm.startPrank(admin);
        vm.expectRevert("Batch too large");
        factory.setBlacklist(many, 1 days);
        vm.expectRevert("Batch too large");
        factory.liftBlacklist(many);
        vm.stopPrank();
    }

    function test_revert_bounds_invalid() public {
        vm.startPrank(admin);
        vm.expectRevert(ToshFactory.InvalidBounds.selector);
        factory.setHardCapBounds(2e18, 1e18);
        uint256 absMax = factory.ABS_MAX_CAP();
        vm.expectRevert(ToshFactory.InvalidBounds.selector);
        factory.setHardCapBounds(1e18, absMax + 1);
        vm.expectRevert(ToshFactory.InvalidBounds.selector);
        factory.setAgentCapBounds(1e18, 0.5e18);
        vm.stopPrank();
    }

    function test_revert_createLaunch_inputs() public {
        bytes32 salt = _pickSalt(HARD_CAP, AGENT_CAP, DURATION);
        vm.startPrank(admin);
        vm.expectRevert(ToshFactory.InvalidDeveloper.selector);
        factory.createLaunch("X", "X", address(0), fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch("", "X", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.expectRevert(ToshFactory.NameTaken.selector);
        factory.createLaunch("Alpha", "Alpha", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.expectRevert();
        factory.createLaunch("X", "X", dev, fund, salt, HARD_CAP, AGENT_CAP, 5 hours);
        vm.stopPrank();
    }

    // ─── address prediction ───────────────────────────────────────────────────

    function test_predictAndVerifyHook() public {
        bytes32 salt = _pickSalt(HARD_CAP, AGENT_CAP, DURATION);
        bytes32 initHash = factory.hookInitcodeHash(dev, admin, HARD_CAP, AGENT_CAP, DURATION);
        address predicted = factory.predictHookAddress(admin, salt, initHash);
        vm.prank(admin);
        (, address h) = factory.createLaunch("Beta", "Beta", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        assertEq(h, predicted);
        assertTrue(factory.verifyHookDeployment(h, admin, dev, HARD_CAP, AGENT_CAP, DURATION, salt));
        assertFalse(factory.verifyHookDeployment(h, admin, dev, HARD_CAP + 1, AGENT_CAP, DURATION, salt));
        assertFalse(factory.verifyHookDeployment(trader, admin, dev, HARD_CAP, AGENT_CAP, DURATION, salt));
    }

    // ─── one-shot initialisers ────────────────────────────────────────────────

    function test_revert_initialisersAreOneShot() public {
        vm.expectRevert(ToshToken.OnlyFactory.selector);
        token.initialize(address(hook), "X", "X");
        vm.prank(address(factory));
        vm.expectRevert(ToshToken.AlreadyInitialized.selector);
        token.initialize(address(hook), "X", "X");

        vm.expectRevert(ToshLaunchpadHook.OnlyFactory.selector);
        hook.initializeToken(address(token), dev, fund);
        vm.prank(address(factory));
        vm.expectRevert(ToshLaunchpadHook.AlreadyInitialized.selector);
        hook.initializeToken(address(token), dev, fund);

        ToshLaunchpadHook impl = ToshLaunchpadHook(payable(factory.hookImplementation()));
        vm.prank(address(factory));
        vm.expectRevert(ToshLaunchpadHook.NotAClone.selector);
        impl.initializeToken(address(token), dev, fund);
    }

    function test_tokenMetadata() public view {
        assertEq(token.name(), "Alpha");
        assertEq(token.symbol(), "Alpha");
        assertEq(token.decimals(), 18);
    }

    function test_revert_setProjectFund() public {
        vm.prank(trader);
        vm.expectRevert(ToshLaunchpadHook.OnlyProjectController.selector);
        hook.setProjectFund(trader);
        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHook.ZeroAddress.selector);
        hook.setProjectFund(address(0));
    }

    // ─── gateway ──────────────────────────────────────────────────────────────

    function _gateway() internal returns (MockSafe safe, ToshLaunchGateway gw, address signer) {
        safe = new MockSafe();
        signer = makeAddr("signer");
        safe.add(signer);
        gw = new ToshLaunchGateway(address(factory), address(safe));
        vm.prank(admin);
        factory.transferOwnership(address(gw));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
    }

    function test_gateway_safeRunsTheBrakes_errorsBubble() public {
        (MockSafe safe, ToshLaunchGateway gw, address signer) = _gateway();
        assertEq(gw.getOwners()[0], signer);
        assertTrue(gw.canLaunch(signer));
        assertTrue(gw.canLaunch(address(safe)));

        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeCall(ToshFactory.pause, ()))));
        assertTrue(factory.paused());

        vm.prank(address(safe));
        vm.expectRevert(ToshFactory.HaltDurationTooLong.selector);
        gw.execute(abi.encodeCall(ToshFactory.haltLadderMinting, (address(hook), 0)));
    }

    function test_gateway_removedSignerLosesListing() public {
        (MockSafe safe, ToshLaunchGateway gw, address signer) = _gateway();
        safe.remove(signer);
        assertFalse(gw.canLaunch(signer));
        vm.prank(signer);
        vm.expectRevert(ToshLaunchGateway.NotLauncher.selector);
        gw.createLaunch("Z", "Z", dev, fund, bytes32(uint256(1)), HARD_CAP, AGENT_CAP, DURATION);
    }

    function test_revert_gateway_zeroAddresses() public {
        vm.expectRevert(ToshLaunchGateway.ZeroAddress.selector);
        new ToshLaunchGateway(address(0), address(1));
        vm.expectRevert(ToshLaunchGateway.ZeroAddress.selector);
        new ToshLaunchGateway(address(factory), address(0));
    }

    // ─── bid book registry ────────────────────────────────────────────────────

    function test_bidBook_listsItsFactories() public view {
        address[] memory fs = book.factories();
        assertEq(fs.length, 1);
        assertEq(fs[0], address(factory));
        assertEq(book.factoryOf(address(hook)), address(factory));
        assertEq(book.factoryOf(trader), address(0));
    }
}
