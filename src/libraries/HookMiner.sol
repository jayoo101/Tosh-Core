// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HookMiner
/// @notice CREATE2 address prediction for hook clones.
///
///         ── The name is now wrong, and that is deliberate for one commit ────
///
///         Nothing mines. This library used to grind CREATE2 salts until the
///         resulting address carried Uniswap V4's permission mask in its low
///         bits, because that is where V4 read a hook's permissions from. Under
///         PancakeSwap Infinity permissions come from
///         `ToshLaunchpadHook.getHooksRegistrationBitmap()`, and
///         `CLPoolManager.initialize` refuses a pool whose `PoolKey.parameters`
///         disagrees with it — so the permission set is still pinned to the key,
///         by equality rather than by address arithmetic, and an address has
///         nothing left to encode.
///
///         The file keeps its name only because the test suite is being ported
///         in parallel and a rename would collide with that work. It should
///         become `HookAddress` in a commit of its own, once the tests land.
///         See docs/PANCAKESWAP_INFINITY.md §3.3.
///
///         ── What went, and what the removal proves ──────────────────────────
///
///         Deleted: `find`, `isValidHookAddress`, and all fourteen V4 flag
///         constants including `REQUIRED_FLAGS = 0x20CC`.
///
///         They are removed rather than deprecated on purpose. A bit-check that
///         no longer means anything is worse than no check: it still rejects
///         salts, so a launch would keep paying to mine for a property nothing
///         reads, and the next person to touch it would reasonably assume the
///         mask still mattered. Deleting them makes every remaining caller fail
///         to compile, which is the only way to find them all.
///
///         `soat-frontend/src/app/lib/hookMiner.ts` mirrored those constants and
///         is stale for the same reason. `scripts/checkHookMinerTuple.mjs`
///         existed to keep the two miners agreeing on the mask; with no mask
///         there is nothing for it to compare.
library HookMiner {
    /// @notice The address `deployer` will deploy to for `salt` and
    ///         `initcodeHash`.
    ///
    /// @dev    Plain CREATE2 arithmetic, unchanged by the port — the address a
    ///         salt produces was never Uniswap-specific, only the question of
    ///         which addresses were ACCEPTABLE was.
    ///
    ///         Still load-bearing. `ToshFactory.createLaunch` derives its salt
    ///         as `keccak256(creator, hookSalt)`, which keeps a launch's address
    ///         deterministic and bound to its creator, so one creator cannot
    ///         front-run another's predicted address. The launch UI shows that
    ///         address before the transaction and `verifyHookDeployment` checks
    ///         it after.
    function computeAddress(address deployer, bytes32 salt, bytes32 initcodeHash)
        internal
        pure
        returns (address hookAddress)
    {
        hookAddress = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initcodeHash)))));
    }
}
