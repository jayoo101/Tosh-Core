// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLaunchGateway} from "../src/ToshLaunchGateway.sol";
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";

/// @dev The two Safe reads the gateway makes, over an owner list a test can edit.
contract MockSafeOwners {
    address[] internal owners;

    constructor(address[] memory owners_) {
        owners = owners_;
    }

    function isOwner(address who) external view returns (bool) {
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == who) return true;
        }
        return false;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function removeOwner(address who) external {
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == who) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                return;
            }
        }
    }
}

contract ToshLaunchGatewayTest is Test {
    address internal signerA = makeAddr("signerA");
    address internal signerB = makeAddr("signerB");
    address internal signerC = makeAddr("signerC");
    address internal stranger = makeAddr("stranger");
    address internal developer = makeAddr("developer");

    uint256 internal constant HARD_CAP = 20_000e8;
    uint256 internal constant WALLET_CAP = 1_000e8;

    MockSafeOwners internal safe;
    ToshFactory internal factory;
    ToshLaunchGateway internal gateway;

    function setUp() public {
        address[] memory owners = new address[](3);
        owners[0] = signerA;
        owners[1] = signerB;
        owners[2] = signerC;
        safe = new MockSafeOwners(owners);

        MockQuoteAsset quote = new MockQuoteAsset();
        factory = new ToshFactory(
            makeAddr("poolManager"),
            makeAddr("vault"),
            makeAddr("pogSigner"),
            makeAddr("treasury"),
            payable(makeAddr("ladder")),
            address(quote)
        );
        factory.transferOwnership(address(safe));
        vm.prank(address(safe));
        factory.acceptOwnership();

        gateway = new ToshLaunchGateway(address(factory), address(safe));

        // The handoff as the Safe batches it: propose, then accept through the
        // gateway, in one transaction.
        vm.startPrank(address(safe));
        factory.transferOwnership(address(gateway));
        gateway.execute(abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        vm.stopPrank();
    }

    function _salt(address creator, uint256 duration) internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(developer, creator, HARD_CAP, WALLET_CAP, duration);
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            if (factory.predictHookAddress(creator, rawSalt, initHash).code.length == 0) return rawSalt;
        }
        revert("no free salt");
    }

    function _list(address caller, string memory name, string memory symbol)
        internal
        returns (address token, address hook)
    {
        bytes32 salt = _salt(address(gateway), 24 hours);
        vm.prank(caller);
        (token, hook) = gateway.createLaunch(name, symbol, developer, salt, HARD_CAP, WALLET_CAP, 24 hours);
    }

    function test_handoffMakesTheGatewayTheOwner() public view {
        assertEq(factory.owner(), address(gateway));
        assertEq(factory.pendingOwner(), address(0));
    }

    function test_everySafeSignerCanList() public {
        (, address hookA) = _list(signerA, "Alpha", "ALP");
        (, address hookB) = _list(signerB, "Beta", "BET");
        (, address hookC) = _list(signerC, "Gamma", "GAM");

        assertTrue(factory.registeredHooks(hookA));
        assertTrue(factory.registeredHooks(hookB));
        assertTrue(factory.registeredHooks(hookC));
        assertEq(ToshLaunchpadHook(payable(hookA)).creator(), address(gateway));
        assertEq(ToshLaunchpadHook(payable(hookA)).projectTreasury(), developer);
    }

    function test_theSafeItselfCanStillList() public {
        (, address hook) = _list(address(safe), "Delta", "DLT");
        assertTrue(factory.registeredHooks(hook));
    }

    function test_strangerCannotList() public {
        bytes32 salt = _salt(address(gateway), 24 hours);
        vm.prank(stranger);
        vm.expectRevert(ToshLaunchGateway.NotLauncher.selector);
        gateway.createLaunch("Nope", "NOPE", developer, salt, HARD_CAP, WALLET_CAP, 24 hours);
    }

    function test_removedSignerLosesTheRightAtOnce() public {
        assertTrue(gateway.canLaunch(signerB));
        safe.removeOwner(signerB);
        assertFalse(gateway.canLaunch(signerB));

        bytes32 salt = _salt(address(gateway), 24 hours);
        vm.prank(signerB);
        vm.expectRevert(ToshLaunchGateway.NotLauncher.selector);
        gateway.createLaunch("Late", "LATE", developer, salt, HARD_CAP, WALLET_CAP, 24 hours);
    }

    function test_signerCannotCallTheFactoryDirectly() public {
        bytes32 salt = _salt(signerA, 24 hours);
        vm.prank(signerA);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signerA));
        factory.createLaunch("Direct", "DIR", developer, salt, HARD_CAP, WALLET_CAP, 24 hours);
    }

    function test_launchIsGatedTheSameWay() public {
        (, address hook) = _list(signerA, "Alpha", "ALP");

        vm.prank(stranger);
        vm.expectRevert(ToshLaunchGateway.NotLauncher.selector);
        gateway.launch(hook);

        // A signer gets through the gateway and reaches the hook, which refuses
        // only because this round's genesis is still open.
        vm.prank(signerC);
        (bool ok, bytes memory ret) = address(gateway).call(abi.encodeCall(ToshLaunchGateway.launch, (hook)));
        assertFalse(ok);
        assertTrue(bytes4(ret) != ToshLaunchGateway.NotLauncher.selector);
        assertTrue(bytes4(ret) != Ownable.OwnableUnauthorizedAccount.selector);
    }

    function test_signerCannotExecute() public {
        vm.prank(signerA);
        vm.expectRevert(ToshLaunchGateway.NotSafe.selector);
        gateway.execute(abi.encodeCall(ToshFactory.pause, ()));
    }

    function test_safeAdministersThroughExecute() public {
        vm.prank(address(safe));
        gateway.execute(abi.encodeCall(ToshFactory.pause, ()));
        assertTrue(factory.paused());

        bytes32 salt = _salt(address(gateway), 24 hours);
        vm.prank(signerA);
        vm.expectRevert(); // EnforcedPause, from the factory
        gateway.createLaunch("Paused", "PSD", developer, salt, HARD_CAP, WALLET_CAP, 24 hours);

        vm.prank(address(safe));
        gateway.execute(abi.encodeCall(ToshFactory.unpause, ()));
        assertFalse(factory.paused());
    }

    function test_executeBubblesTheFactorysRevert() public {
        vm.prank(address(safe));
        vm.expectRevert(ToshFactory.OwnershipCannotBeRenounced.selector);
        gateway.execute(abi.encodeCall(Ownable.renounceOwnership, ()));
    }

    function test_getOwnersMirrorsTheSafe() public view {
        address[] memory owners = gateway.getOwners();
        assertEq(owners.length, 3);
        assertEq(owners[0], signerA);
    }

    function test_safeCanRetireTheGateway() public {
        vm.prank(address(safe));
        gateway.execute(abi.encodeCall(Ownable.transferOwnership, (address(safe))));
        vm.prank(address(safe));
        factory.acceptOwnership();
        assertEq(factory.owner(), address(safe));

        bytes32 salt = _salt(address(gateway), 24 hours);
        vm.prank(signerA);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(gateway)));
        gateway.createLaunch("Gone", "GONE", developer, salt, HARD_CAP, WALLET_CAP, 24 hours);
    }

    function test_constructorRefusesZero() public {
        vm.expectRevert(ToshLaunchGateway.ZeroAddress.selector);
        new ToshLaunchGateway(address(0), address(safe));
        vm.expectRevert(ToshLaunchGateway.ZeroAddress.selector);
        new ToshLaunchGateway(address(factory), address(0));
    }
}
