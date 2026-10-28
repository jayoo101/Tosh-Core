// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentIdLib} from "../../src/libraries/AgentIdLib.sol";
import {MockAgentRegistry} from "./utils/MockAgentRegistry.sol";
import {V2LibHarness} from "./utils/V2LibHarness.sol";

contract AgentIdLibTest is Test {
    V2LibHarness internal h;
    MockAgentRegistry internal reg;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        h = new V2LibHarness();
        reg = new MockAgentRegistry();
        reg.setHandle(alice, "alice");
    }

    function test_keyIsHashOfHandle() public view {
        assertEq(h.agentKeyOf(address(reg), alice), keccak256("alice"));
    }

    function test_noHandleIsZero() public view {
        assertEq(h.agentKeyOf(address(reg), bob), bytes32(0));
    }

    function test_handleThatPointsElsewhereIsZero() public {
        reg.setOwnerOnly("alice", bob);
        assertEq(h.agentKeyOf(address(reg), alice), bytes32(0));
    }

    function test_keyFollowsTheNameNotTheAddress() public {
        // An admin moves "alice" to bob: bob inherits alice's key, so her
        // allowance is not issued twice.
        reg.setHandle(bob, "alice");
        assertEq(h.agentKeyOf(address(reg), bob), keccak256("alice"));
    }

    function test_longestAcceptedHandle() public {
        string memory name = string(new bytes(256));
        reg.setHandle(alice, name);
        assertEq(h.agentKeyOf(address(reg), alice), keccak256(bytes(name)));
    }

    function test_handleOver256BytesIsUnavailable() public {
        reg.setHandle(alice, string(new bytes(257)));
        vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
        h.agentKeyOf(address(reg), alice);
    }

    function test_registryWithNoCodeIsUnavailable() public {
        vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
        h.agentKeyOf(makeAddr("nothing"), alice);
    }

    function test_misbehavingRegistryIsUnavailable() public {
        MockAgentRegistry.Mode[6] memory modes = [
            MockAgentRegistry.Mode.Revert,
            MockAgentRegistry.Mode.BurnGas,
            MockAgentRegistry.Mode.BadOffset,
            MockAgentRegistry.Mode.LengthPastEnd,
            MockAgentRegistry.Mode.Oversized,
            MockAgentRegistry.Mode.DirtyAddress
        ];
        for (uint256 i; i < modes.length; ++i) {
            reg.setMode(modes[i]);
            vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
            h.agentKeyOf(address(reg), alice);
        }
    }

    function test_gasBombIsCapped() public {
        reg.setMode(MockAgentRegistry.Mode.BurnGas);
        uint256 before = gasleft();
        try h.agentKeyOf(address(reg), alice) {} catch {}
        assertLt(before - gasleft(), AgentIdLib.GAS_LIMIT + 30_000);
    }
}
