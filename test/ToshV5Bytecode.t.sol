// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Guards against a stale `soat-frontend/src/app/lib/hookBytecode.ts`.
///
///         The frontend CREATE2 miner hashes this artefact with the v5.0
///         constructor tuple.  If the Solidity hook changes and the TS file is
///         not regenerated, every `createLaunch` from the UI reverts with
///         `InvalidHookSalt`.  Note that a comment-only edit is enough to trip
///         this: Solidity appends a metadata hash of the source to the creation
///         code, so the bytecode moves even when the logic does not.
///
///         `ToshV5AbiTest` is the sibling guard for `abis.ts`.
///
///         How to fix when this fails:
///             forge build
///             node scripts/extractBytecode.js
contract ToshV5BytecodeTest is Test {
    function test_hookBytecode_inSyncWithArtifact() public view {
        string memory artifactJson = vm.readFile("out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json");
        bytes memory artifactBytecode = bytes(vm.parseJsonString(artifactJson, ".bytecode.object"));

        string memory tsFileStr = vm.readFile("soat-frontend/src/app/lib/hookBytecode.ts");
        bytes memory tsBytecode = _extractHexLiteral(bytes(tsFileStr));

        require(
            keccak256(artifactBytecode) == keccak256(tsBytecode),
            "hookBytecode.ts is OUT OF SYNC with the Foundry artifact. Run: node scripts/extractBytecode.js"
        );
    }

    function _extractHexLiteral(bytes memory src) internal pure returns (bytes memory hex_) {
        uint256 n = src.length;
        uint256 start = type(uint256).max;
        for (uint256 i; i + 2 < n; ++i) {
            if (src[i] == '"' && src[i + 1] == "0" && src[i + 2] == "x") {
                start = i + 1;
                break;
            }
        }
        require(start != type(uint256).max, "hookBytecode.ts: no hex literal");

        uint256 end = type(uint256).max;
        for (uint256 j = start; j < n; ++j) {
            if (src[j] == '"') {
                end = j;
                break;
            }
        }
        require(end != type(uint256).max, "hookBytecode.ts: unterminated literal");

        hex_ = new bytes(end - start);
        for (uint256 k; k < end - start; ++k) {
            hex_[k] = src[start + k];
        }
    }
}
