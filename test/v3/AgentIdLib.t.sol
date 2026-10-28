// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentIdLib} from "../../src/libraries/AgentIdLib.sol";
import {MockAgentRegistryV3} from "./utils/MockAgentRegistryV3.sol";
import {V2LibHarnessV3} from "./utils/V2LibHarnessV3.sol";

contract AgentIdLibTestV3 is Test {
    V2LibHarnessV3 internal h;
    MockAgentRegistryV3 internal reg;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        h = new V2LibHarnessV3();
        reg = new MockAgentRegistryV3();
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
        MockAgentRegistryV3.Mode[6] memory modes = [
            MockAgentRegistryV3.Mode.Revert,
            MockAgentRegistryV3.Mode.BurnGas,
            MockAgentRegistryV3.Mode.BadOffset,
            MockAgentRegistryV3.Mode.LengthPastEnd,
            MockAgentRegistryV3.Mode.Oversized,
            MockAgentRegistryV3.Mode.DirtyAddress
        ];
        for (uint256 i; i < modes.length; ++i) {
            reg.setMode(modes[i]);
            vm.expectRevert(AgentIdLib.AgentRegistryUnavailable.selector);
            h.agentKeyOf(address(reg), alice);
        }
    }

    function test_gasBombIsCapped() public {
        reg.setMode(MockAgentRegistryV3.Mode.BurnGas);
        uint256 before = gasleft();
        try h.agentKeyOf(address(reg), alice) {} catch {}
        assertLt(before - gasleft(), AgentIdLib.GAS_LIMIT + 30_000);
    }
}
