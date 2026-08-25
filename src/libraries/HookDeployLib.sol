// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ToshLaunchpadHook} from "../ToshLaunchpadHook.sol";

/// @title  HookDeployLib
/// @notice External library that **isolates ToshLaunchpadHook's creation code**
///         from ToshFactory, keeping the factory under the EIP-170 24 KB limit.
///
/// @dev    All public functions are invoked via DELEGATECALL by ToshFactory.
///         In that context:
///           • address(this) == ToshFactory  → CREATE2 deployer == factory ✓
///           • storage reads/writes hit the factory's storage slot space ✓
///
///         Because of the DELEGATECALL semantics, callers should always pass
///         `factoryAddr = address(this)` from the factory side even though
///         `address(this)` inside the library already resolves to the factory.
///         The explicit parameter is kept for clarity and off-chain tooling.
///
/// @dev    v5.0 CONSTRUCTOR CHANGE — `satoToken` was removed (the protocol is
///         ETH-native), and `ladderTreasury` plus `perWalletCap` were added.
///         `genesisDuration` then made it 9 fields, so every off-chain salt
///         miner MUST be regenerated: an initcode hash computed against an
///         older tuple yields a stale CREATE2 prediction and `createLaunch`
///         reverts with `InvalidHookSalt`.
library HookDeployLib {
    // ─────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deploy a ToshLaunchpadHook via CREATE2 using the supplied salt
    ///         and constructor arguments.
    ///
    /// @param  finalSalt       Creator-bound salt: keccak256(abi.encode(creator, rawSalt)).
    /// @param  poolManager     Uniswap V4 PoolManager address.
    /// @param  factoryAddr     ToshFactory address (= address(this) in DELEGATECALL context).
    /// @param  projectTreasury Project multisig held as immutable launch-time metadata.
    /// @param  creator         Creator address (msg.sender in createLaunch).
    /// @param  projectAdmin    Mutable admin authorised to receive the 99 % Phase-2 cut.
    /// @param  ladderTreasury  Platform buyback reservoir (ToshLadderTreasury).
    /// @param  softCap         Per-launch ETH soft-cap baked immutably into the hook.
    /// @param  perWalletCap    Per-wallet ETH deposit cap baked immutably into the hook.
    /// @param  genesisDuration Genesis window length; the hook rejects anything
    ///                         outside {3 h, 24 h, 72 h}.
    /// @return deployed        Address of the newly deployed hook, or address(0) on failure.
    function deployHook(
        bytes32 finalSalt,
        address poolManager,
        address factoryAddr,
        address projectTreasury,
        address creator,
        address projectAdmin,
        address ladderTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external returns (address deployed) {
        bytes memory initcode = abi.encodePacked(
            type(ToshLaunchpadHook).creationCode,
            abi.encode(
                poolManager,
                factoryAddr,
                projectTreasury,
                creator,
                projectAdmin,
                ladderTreasury,
                softCap,
                perWalletCap,
                genesisDuration
            )
        );
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), finalSalt)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Hash helpers (pure — no state access)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice keccak256 of the full initcode (creation code + encoded constructor args).
    ///         Used for CREATE2 address prediction and hook-deployment verification.
    function computeInitcodeHash(
        address poolManager,
        address factoryAddr,
        address projectTreasury,
        address creator,
        address projectAdmin,
        address ladderTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(ToshLaunchpadHook).creationCode,
                abi.encode(
                    poolManager,
                    factoryAddr,
                    projectTreasury,
                    creator,
                    projectAdmin,
                    ladderTreasury,
                    softCap,
                    perWalletCap,
                    genesisDuration
                )
            )
        );
    }

    /// @notice keccak256 of ToshLaunchpadHook.creationCode alone (no constructor args).
    ///         Stored as ToshFactory.HOOK_CREATION_CODEHASH for off-chain trust checks.
    function creationCodeHash() external pure returns (bytes32) {
        return keccak256(type(ToshLaunchpadHook).creationCode);
    }
}
