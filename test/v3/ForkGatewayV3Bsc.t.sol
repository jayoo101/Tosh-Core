// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshLaunchGatewayV3} from "../../src/v3/ToshLaunchGatewayV3.sol";

/// @notice Rehearsal of the live hand-over on a BSC mainnet fork: the Safe
///         moves the BNB factory from the deployed gateway to a fresh
///         `ToshLaunchGatewayV3` and halts $TOSH's shelf for good, in the order
///         the Safe batch runs it. Skipped unless `BSC_RPC` is set.
contract ForkGatewayV3BscTest is Test {
    address constant SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    ToshFactoryV3 constant FACTORY = ToshFactoryV3(0x091d0cBD1e3B7D8b2a6fd8e0795b784EdDFfb590);
    ToshLaunchGateway constant OLD = ToshLaunchGateway(0x790091e8965eCc1adfA40AA9b95515C6289dCE9d);
    address constant TOSH_HOOK = 0x45F29984B980f3D076CD05e7BE72E3b357856bC8;

    bool live;
    ToshLaunchGatewayV3 gw;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        gw = new ToshLaunchGatewayV3(address(FACTORY), SAFE);
    }

    function _batch() internal {
        vm.startPrank(SAFE);
        OLD.execute(abi.encodeCall(FACTORY.transferOwnership, (address(gw))));
        gw.execute(abi.encodeWithSignature("acceptOwnership()"));
        gw.haltForever(TOSH_HOOK);
        vm.stopPrank();
    }

    function test_fork_handoverAndPermanentHalt() public {
        if (!live) return;
        assertEq(FACTORY.owner(), address(OLD));
        _batch();

        assertEq(FACTORY.owner(), address(gw));
        assertEq(FACTORY.pendingOwner(), address(0));
        assertTrue(gw.haltedForever(TOSH_HOOK));
        assertTrue(FACTORY.ladderMintingHalted(TOSH_HOOK));
        assertEq(FACTORY.hookLadderHaltedUntil(TOSH_HOOK), block.timestamp + 7 days);
        assertTrue(gw.canLaunch(0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB));

        vm.startPrank(SAFE);
        vm.expectRevert(ToshLaunchGatewayV3.HaltIsPermanent.selector);
        gw.execute(abi.encodeCall(ToshFactoryV3.resumeLadderMinting, (TOSH_HOOK)));
        vm.expectRevert(ToshLaunchGatewayV3.OwnershipLocked.selector);
        gw.execute(abi.encodeCall(FACTORY.transferOwnership, (SAFE)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(OLD)));
        OLD.execute(abi.encodeCall(ToshFactoryV3.resumeLadderMinting, (TOSH_HOOK)));
        vm.stopPrank();
    }

    function test_fork_keeperRenewsWithoutAKey() public {
        if (!live) return;
        _batch();
        vm.warp(block.timestamp + 6 days);
        vm.prank(makeAddr("anyone"));
        gw.renewAll();
        assertEq(FACTORY.hookLadderHaltedUntil(TOSH_HOOK), block.timestamp + 7 days);
    }
}
