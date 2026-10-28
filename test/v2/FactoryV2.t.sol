// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2Base} from "./utils/V2Base.sol";
import {ToshFactory} from "../../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshHookLens} from "../../src/ToshHookLens.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract MockSafe {
    mapping(address => bool) public isOwner;
    address[] internal _owners;

    function add(address o) external {
        isOwner[o] = true;
        _owners.push(o);
    }

    function remove(address o) external {
        isOwner[o] = false;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory r) = target.call(data);
        require(ok, "exec");
        return r;
    }
}

contract FactoryV2Test is V2Base {
    function test_wiring() public view {
        ToshLaunchpadHook impl = ToshLaunchpadHook(payable(factory.hookImplementation()));
        assertEq(impl.factory(), address(factory));
        assertEq(factory.bidBook(), address(book));
        assertEq(ToshToken(factory.tokenImplementation()).bidBook(), address(book));
        assertEq(factory.HOOK_RUNTIME_CODEHASH(), address(impl).codehash);
        assertEq(book.factoryOf(address(impl)), address(0));
    }

    function test_revert_mismatchedImplementation() public {
        vm.startPrank(admin);
        address predicted = vm.computeCreateAddress(admin, vm.getNonce(admin) + 1);
        ToshLaunchpadHook impl = new ToshLaunchpadHook(
            address(poolManager),
            address(vault),
            predicted,
            address(ladder),
            platform,
            address(quote),
            address(registry),
            MIN_BUY + 1, // differs from the factory's
            true
        );
        vm.expectRevert(ToshFactory.ImplementationMismatch.selector);
        new ToshFactory(
            ToshFactory.Config({
                hookImplementation: address(impl),
                poolManager: address(poolManager),
                vault: address(vault),
                platformTreasury: platform,
                ladderTreasury: address(ladder),
                quoteAsset: address(quote),
                bidBook: address(book),
                agentRegistry: address(registry),
                minBuy: MIN_BUY,
                acceptsNative: true,
                minHardCap: 1e18,
                maxHardCap: 10_000e18,
                minAgentCap: MIN_BUY,
                maxAgentCap: 1_000e18
            })
        );
        vm.stopPrank();
    }

    function test_createLaunch_bounds() public {
        bytes32 salt = _pickSalt(HARD_CAP, AGENT_CAP, DURATION);
        vm.startPrank(admin);
        vm.expectRevert(ToshFactory.HardCapOutOfBounds.selector);
        factory.createLaunch("A", "A", dev, fund, salt, 0.5e18, AGENT_CAP, DURATION);
        vm.expectRevert(ToshFactory.AgentCapOutOfBounds.selector);
        factory.createLaunch("A", "A", dev, fund, salt, HARD_CAP, HARD_CAP + 1, DURATION);
        vm.expectRevert(ToshFactory.AgentCapOutOfBounds.selector);
        factory.createLaunch("A", "A", dev, fund, salt, HARD_CAP, MIN_BUY - 1, DURATION);
        vm.expectRevert(ToshFactory.ZeroAddress.selector);
        factory.createLaunch("A", "A", dev, address(0), salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.stopPrank();
    }

    function test_createLaunch_rejectsFundEqualToHook() public {
        bytes32 salt = _pickSalt(HARD_CAP, AGENT_CAP, DURATION);
        bytes32 initHash = factory.hookInitcodeHash(dev, admin, HARD_CAP, AGENT_CAP, DURATION);
        address predicted = factory.predictHookAddress(admin, salt, initHash);
        vm.prank(admin);
        vm.expectRevert(ToshFactory.ZeroAddress.selector);
        factory.createLaunch("A", "A", dev, predicted, salt, HARD_CAP, AGENT_CAP, DURATION);
    }

    function test_createLaunch_wiresEverything() public {
        (ToshToken token, ToshLaunchpadHook hook) = _create();
        assertGt(uint160(address(token)), uint160(address(quote)), "token is currency1");
        assertEq(hook.projectFund(), fund);
        assertEq(hook.projectController(), dev);
        assertEq(hook.perAgentCap(), AGENT_CAP);
        assertEq(hook.hardCap(), HARD_CAP);
        assertEq(token.bidBook(), address(book));
        assertEq(book.factoryOf(address(hook)), address(factory));
        assertFalse(token.tradingOpen());

        ToshHookLens.GenesisState memory s = lens.genesisState(address(hook));
        assertEq(s.token, address(token));
        assertEq(s.hardCap, HARD_CAP);
        assertEq(s.projectController, dev);
        assertEq(s.publicLaunchAt, hook.genesisDeadline() + 48 hours);
    }

    function test_onlyOwnerListsAndPauseStopsListing() public {
        bytes32 salt = _pickSalt(HARD_CAP, AGENT_CAP, DURATION);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.createLaunch("A", "A", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.prank(admin);
        factory.pause();
        vm.prank(admin);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch("A", "A", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
    }

    function test_bounds_retune() public {
        vm.startPrank(admin);
        factory.setHardCapBounds(10e18, 50e18);
        vm.expectRevert(ToshFactory.InvalidBounds.selector);
        factory.setHardCapBounds(1, 50e18);
        vm.expectRevert(ToshFactory.InvalidBounds.selector);
        factory.setAgentCapBounds(MIN_BUY - 1, 1e18);
        vm.stopPrank();
        assertEq(factory.minHardCap(), 10e18);
    }

    function test_gateway_ownersListSafeAdministers() public {
        MockSafe safe = new MockSafe();
        address signer = makeAddr("signer");
        safe.add(signer);
        ToshLaunchGateway gw = new ToshLaunchGateway(address(factory), address(safe));
        vm.prank(admin);
        factory.transferOwnership(address(gw));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
        assertEq(factory.owner(), address(gw));

        vm.prank(signer);
        (address t,) = gw.createLaunch("G", "G", dev, fund, bytes32(uint256(7)), HARD_CAP, AGENT_CAP, DURATION);
        assertTrue(factory.tokenToHook(t) != address(0));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ToshLaunchGateway.NotLauncher.selector);
        gw.createLaunch("H", "H", dev, fund, bytes32(uint256(8)), HARD_CAP, AGENT_CAP, DURATION);

        vm.prank(signer);
        vm.expectRevert(ToshLaunchGateway.NotSafe.selector);
        gw.execute(abi.encodeCall(ToshFactory.pause, ()));
    }

    function test_renounceDisabled() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.OwnershipCannotBeRenounced.selector);
        factory.renounceOwnership();
    }
}
