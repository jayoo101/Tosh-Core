// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HookMiner
/// @notice Off-chain / test utility: find a CREATE2 salt that places a hook contract
///         at an address accepted by Uniswap V4's PoolManager.
///
///         V4 enforces two hard constraints (isValidHookAddress):
///           (a) The address must have at least one hook flag set in the low 14 bits.
///           (b) "Return-delta" flags (bits 0–3) cannot be set unless their corresponding
///               action flags are also set:
///                 bit 3 (BEFORE_SWAP_RETURNS_DELTA)     → bit 7 (BEFORE_SWAP) required
///                 bit 2 (AFTER_SWAP_RETURNS_DELTA)      → bit 6 (AFTER_SWAP) required
///                 bit 1 (AFTER_ADD_LIQ_RETURNS_DELTA)   → bit 10 (AFTER_ADD_LIQ) required
///                 bit 0 (AFTER_REMOVE_LIQ_RETURNS_DELTA)→ bit 8  (AFTER_REMOVE_LIQ) required
///
///         Required address bits for ToshLaunchpadHook (v5.0):
///           BEFORE_INITIALIZE_FLAG          = 1 << 13 = 0x2000  (pool-init front-run defence)
///           BEFORE_SWAP_FLAG                = 1 << 7  = 0x0080  (exact-input tax)
///           AFTER_SWAP_FLAG                 = 1 << 6  = 0x0040  (oracle + piggyback + exact-output tax)
///           BEFORE_SWAP_RETURNS_DELTA_FLAG  = 1 << 3  = 0x0008  (skim specified = input)
///           AFTER_SWAP_RETURNS_DELTA_FLAG   = 1 << 2  = 0x0004  (skim unspecified = input)
///           Combined: REQUIRED_FLAGS = 0x20CC
///
///         Exact-output buys would otherwise burn the output token and send
///         nothing to the treasury — a router can ask for "N tokens out" on
///         every buy and starve the buyback flywheel.  `afterSwap` returning
///         a delta is what charges the ETH input instead.
///
///         BEFORE_REMOVE_LIQUIDITY is NOT set.  Third-party LPs are
///         welcome to add and withdraw freely, and the genesis position needs
///         no callback to stay locked: V4 keys every position to the address
///         that called `modifyLiquidity`, the genesis position belongs to the
///         hook, and the hook exposes no code path that removes it.  A
///         reverting callback would only have punished retail LPs for the
///         protocol's own guarantee.
///
///         ⚠ v5.0 MIGRATION: the mask changed from 0x2200 → 0x20C8 → 0x20CC,
///           so every previously mined salt is stale.  Both the Solidity miner
///           below and the TypeScript miner in
///           `soat-frontend/src/app/lib/hookMiner.ts` must agree on this
///           constant or `createLaunch` reverts with `InvalidHookSalt`.
///
library HookMiner {
    // ─── Uniswap V4 Hook flag constants ──────────────────────────────────────
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1); // 0x3FFF

    uint160 internal constant BEFORE_INITIALIZE_FLAG = 1 << 13; // 0x2000
    uint160 internal constant AFTER_INITIALIZE_FLAG = 1 << 12; // 0x1000
    uint160 internal constant BEFORE_ADD_LIQUIDITY_FLAG = 1 << 11; // 0x0800
    uint160 internal constant AFTER_ADD_LIQUIDITY_FLAG = 1 << 10; // 0x0400
    uint160 internal constant BEFORE_REMOVE_LIQUIDITY_FLAG = 1 << 9; // 0x0200
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_FLAG = 1 << 8; // 0x0100
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7; // 0x0080
    uint160 internal constant AFTER_SWAP_FLAG = 1 << 6; // 0x0040
    uint160 internal constant BEFORE_DONATE_FLAG = 1 << 5; // 0x0020
    uint160 internal constant AFTER_DONATE_FLAG = 1 << 4; // 0x0010
    uint160 internal constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3; // 0x0008
    uint160 internal constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2; // 0x0004
    uint160 internal constant AFTER_ADD_LIQ_RETURNS_DELTA_FLAG = 1 << 1; // 0x0002
    uint160 internal constant AFTER_REM_LIQ_RETURNS_DELTA_FLAG = 1 << 0; // 0x0001

    /// @notice Required flag bits for ToshLaunchpadHook (v5.0) — 0x20CC.
    uint160 internal constant REQUIRED_FLAGS = BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG
        | BEFORE_SWAP_RETURNS_DELTA_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG;

    // ─── Public helpers ───────────────────────────────────────────────────────

    /// @notice Compute the CREATE2 address for the given deployer, salt, and initcode hash.
    function computeAddress(address deployer, bytes32 salt, bytes32 initcodeHash)
        internal
        pure
        returns (address hookAddress)
    {
        hookAddress = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initcodeHash)))));
    }

    /// @notice True iff `addr` passes V4 `isValidHookAddress` rules and carries all REQUIRED_FLAGS.
    function isValidHookAddress(address addr) internal pure returns (bool) {
        uint160 bits = uint160(addr);

        if (bits & REQUIRED_FLAGS != REQUIRED_FLAGS) return false;

        if (bits & BEFORE_SWAP_RETURNS_DELTA_FLAG != 0 && bits & BEFORE_SWAP_FLAG == 0) return false;
        if (bits & AFTER_SWAP_RETURNS_DELTA_FLAG != 0 && bits & AFTER_SWAP_FLAG == 0) return false;
        if (bits & AFTER_ADD_LIQ_RETURNS_DELTA_FLAG != 0 && bits & AFTER_ADD_LIQUIDITY_FLAG == 0) return false;
        if (bits & AFTER_REM_LIQ_RETURNS_DELTA_FLAG != 0 && bits & AFTER_REMOVE_LIQUIDITY_FLAG == 0) return false;

        return true;
    }

    /// @notice Mine a salt so that the resulting CREATE2 address:
    ///           1. Has all REQUIRED_FLAGS bits set.
    ///           2. Passes V4's isValidHookAddress consistency rules.
    ///
    ///         Intended for off-chain use (scripts / tests).
    ///
    /// @param deployer      Address that will call CREATE2
    /// @param initcodeHash  keccak256 of (creationCode ++ encodedConstructorArgs)
    /// @param startSalt     First salt value to attempt
    /// @param maxAttempts   Maximum iterations before reverting
    /// @return salt         Discovered salt (use as bytes32 in createLaunch)
    /// @return hookAddress  Predicted hook address at that salt
    function find(address deployer, bytes32 initcodeHash, uint256 startSalt, uint256 maxAttempts)
        internal
        pure
        returns (bytes32 salt, address hookAddress)
    {
        for (uint256 i; i < maxAttempts; ++i) {
            salt = bytes32(startSalt + i);
            hookAddress = computeAddress(deployer, salt, initcodeHash);

            if (isValidHookAddress(hookAddress)) {
                return (salt, hookAddress);
            }
        }
        revert("HookMiner: salt not found within maxAttempts");
    }
}
