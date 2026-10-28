// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisCurve} from "../../../src/libraries/GenesisCurve.sol";
import {AgentIdLib} from "../../../src/libraries/AgentIdLib.sol";

/// @notice External wrappers so reverts surface at a call boundary
///         `vm.expectRevert` can see.
contract V2LibHarness {
    function priceAt(uint256 hardCap, uint256 sold) external pure returns (uint256) {
        return GenesisCurve.priceAt(hardCap, sold);
    }

    function costOf(uint256 hardCap, uint256 sold, uint256 amount) external pure returns (uint256) {
        return GenesisCurve.costOf(hardCap, sold, amount);
    }

    function tokensFor(uint256 hardCap, uint256 sold, uint256 budget) external pure returns (uint256, uint256) {
        return GenesisCurve.tokensFor(hardCap, sold, budget);
    }

    function agentKeyOf(address registry, address account) external view returns (bytes32) {
        return AgentIdLib.agentKeyOf(registry, account);
    }
}
