// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The two reads ToshX makes of the Binance Agent ID registry
///         (`.ai` names, soulbound ERC-721) on BSC.
interface IAgentRegistry {
    /// @dev Empty string when `account` holds no name.
    function handleOf(address account) external view returns (string memory);
    function ownerOfHandle(string calldata handle) external view returns (address);
}

/// @title  AgentIdLib
/// @notice Resolves a wallet to the key its genesis allowance is booked under.
///
/// ── Why raw `staticcall` rather than `try` ──────────────────────────────────
///
///   The registry is a contract neither the platform nor the project controls.
///   `try` catches a revert, but not a return value that fails to decode — that
///   reverts in the caller with no error the frontend can name — and it copies
///   whatever the callee returns, however large. Both reads therefore run with
///   a fixed gas stipend, refuse oversized return data before copying it, and
///   validate the ABI layout by hand. Every failure mode collapses to one
///   error, `AgentRegistryUnavailable`, so a broken registry stops genesis
///   buys and nothing else: launch, transfers and the bid book never call it.
///
/// ── Why the key is the name, not the address ────────────────────────────────
///
///   The registry admin can issue names directly, so the address a name points
///   at is not guaranteed to stay fixed. Keying the allowance by
///   `keccak256(handle)` means a name moved to a new address arrives with its
///   allowance already spent.
library AgentIdLib {
    uint256 internal constant GAS_LIMIT = 100_000;

    /// @dev 64 bytes of ABI head plus a 256-byte name. Real handles are far
    ///      shorter; anything longer is treated as a malfunction.
    uint256 private constant MAX_HANDLE_RETURN = 64 + 256;

    error AgentRegistryUnavailable();

    /// @notice `keccak256(handle)` for an account whose name resolves back to
    ///         it, or zero when it has no name or the two reads disagree.
    function agentKeyOf(address registry, address account) internal view returns (bytes32) {
        bytes memory handle = handleOf(registry, account);
        if (handle.length == 0) return bytes32(0);
        if (ownerOfHandle(registry, handle) != account) return bytes32(0);
        return keccak256(handle);
    }

    function handleOf(address registry, address account) internal view returns (bytes memory handle) {
        bytes memory ret =
            _boundedStaticcall(registry, abi.encodeCall(IAgentRegistry.handleOf, (account)), MAX_HANDLE_RETURN);
        if (ret.length < 64) revert AgentRegistryUnavailable();

        uint256 offset;
        uint256 len;
        assembly ("memory-safe") {
            offset := mload(add(ret, 0x20))
            len := mload(add(ret, 0x40))
        }
        if (offset != 0x20 || len > ret.length - 64) revert AgentRegistryUnavailable();

        handle = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(handle, 0x20), add(ret, 0x60), len)
        }
    }

    function ownerOfHandle(address registry, bytes memory handle) internal view returns (address owner) {
        bytes memory ret =
            _boundedStaticcall(registry, abi.encodeCall(IAgentRegistry.ownerOfHandle, (string(handle))), 32);
        if (ret.length != 32) revert AgentRegistryUnavailable();

        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(ret, 0x20))
        }
        if (word >> 160 != 0) revert AgentRegistryUnavailable();
        owner = address(uint160(word));
    }

    /// @dev Reverts `AgentRegistryUnavailable` on a failed call, on any return
    ///      larger than `maxReturn`, and — because a call to an address with no
    ///      code succeeds with empty return data — on a missing registry, via
    ///      the callers' length checks.
    function _boundedStaticcall(address target, bytes memory data, uint256 maxReturn)
        private
        view
        returns (bytes memory ret)
    {
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            ok := staticcall(GAS_LIMIT, target, add(data, 0x20), mload(data), 0, 0)
            size := returndatasize()
        }
        if (!ok || size > maxReturn) revert AgentRegistryUnavailable();

        ret = new bytes(size);
        assembly ("memory-safe") {
            returndatacopy(add(ret, 0x20), 0, size)
        }
    }
}
