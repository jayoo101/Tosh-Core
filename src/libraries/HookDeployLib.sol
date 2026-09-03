// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ToshLaunchpadHook} from "../ToshLaunchpadHook.sol";

/// @title  HookDeployLib
/// @notice External library that **isolates ToshLaunchpadHook's creation code**
///         from ToshFactory, keeping the factory under the EIP-170 24 KB limit.
///
/// @dev    All public functions are invoked via DELEGATECALL by ToshFactory.
///         In that context:
///           • address(this) == ToshFactory  → CREATE deployer == factory ✓
///           • storage reads/writes hit the factory's storage slot space ✓
///
/// ── v5.1: this library now runs exactly once per platform ────────────────────
///
///   Until v5.0 this built a full per-project initcode — `creationCode` plus
///   nine encoded constructor arguments — and CREATE2'd a fresh 19,586-byte copy
///   of the hook for every launch. That was 3,917,200 gas of code deposit per
///   project, 78 % of `createLaunch`.
///
///   Projects are now 121-byte EIP-1167 clones (see `ToshCloneLib`), so the
///   only thing left to deploy from here is the single shared implementation
///   they all delegate to. `deployImplementation` is called once, from the
///   factory's constructor.
///
///   The library still exists for the same reason it always did: `new
///   ToshLaunchpadHook(...)` embeds the hook's 19.5 KB creation code into
///   whichever contract contains the expression. Putting it here keeps it out of
///   ToshFactory's own bytecode.
///
/// ⚠ EVERY PREVIOUSLY MINED SALT IS STALE. The initcode being hashed changed
///   shape completely — from `creationCode ++ abi.encode(9 args)` to a 131-byte
///   clone stub — so any off-chain miner must be regenerated against
///   `ToshFactory.hookInitcodeHash`, which now takes five arguments rather than
///   six. A hash computed the old way yields a CREATE2 prediction that fails
///   `InvalidHookSalt`.
library HookDeployLib {
    /// @notice Deploy the one shared hook implementation that every project's
    ///         clone delegates to.
    ///
    /// @dev    Called from ToshFactory's constructor, and therefore by
    ///         DELEGATECALL: `address(this)` is the factory, which is what makes
    ///         the implementation's `factory` immutable correct without the
    ///         factory having to exist first. That closes the circular
    ///         dependency — the implementation needs the factory's address, the
    ///         factory needs the implementation's — and it does so structurally:
    ///         there is no deploy-script ordering that can wire the pair up
    ///         wrong, and no per-project byte spent carrying the factory address
    ///         in every clone.
    ///
    ///         Plain CREATE, not CREATE2. The implementation is never a hook
    ///         itself — it refuses to execute as itself, see `onlyClone` — so its
    ///         address carries no V4 permission bits and nothing needs to predict
    ///         it. Clones commit to it by baking it into their own runtime.
    ///
    /// @param poolManager    Uniswap V4 PoolManager.
    /// @param ladderTreasury Platform buyback reservoir.
    /// @return impl          The shared implementation.
    function deployImplementation(address poolManager, address ladderTreasury) external returns (address impl) {
        impl = address(new ToshLaunchpadHook(poolManager, address(this), ladderTreasury));
    }

    /// @notice keccak256 of ToshLaunchpadHook.creationCode.
    ///
    /// @dev    Stored as `ToshFactory.HOOK_CREATION_CODEHASH` so off-chain
    ///         tooling can verify the deployed implementation was built from the
    ///         audited source. It is a build fingerprint only — no longer a
    ///         mining input, because clones do not embed this code.
    function creationCodeHash() external pure returns (bytes32) {
        return keccak256(type(ToshLaunchpadHook).creationCode);
    }
}
