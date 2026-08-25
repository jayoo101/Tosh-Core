import { keccak256, encodeAbiParameters, parseAbiParameters, concat } from "viem"
import { HOOK_BYTECODE } from "./hookBytecode"

// ── Flags (mirror of Solidity HookMiner.sol) ─────────────────────────────────
// BEFORE_INITIALIZE | BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA
export const REQUIRED_FLAGS = BigInt(0x20CC)
const BEFORE_SWAP_FLAG = BigInt(1 << 7)
const AFTER_SWAP_FLAG  = BigInt(1 << 6)
const AFTER_ADD_FLAG   = BigInt(1 << 10)
const AFTER_REM_FLAG   = BigInt(1 << 8)
const BEFORE_SWAP_DELTA_FLAG = BigInt(1 << 3)
const AFTER_SWAP_DELTA_FLAG  = BigInt(1 << 2)
const AFTER_ADD_DELTA_FLAG   = BigInt(1 << 1)
const AFTER_REM_DELTA_FLAG   = BigInt(1 << 0)

/** Replicates Solidity create2 address derivation. */
export function computeCreate2Address(
  deployer:     `0x${string}`,
  salt:         `0x${string}`,
  initcodeHash: `0x${string}`
): `0x${string}` {
  const hash = keccak256(concat(["0xff", deployer, salt, initcodeHash]))
  return `0x${hash.slice(26)}` as `0x${string}`
}

/** Mirror of Solidity HookMiner.isValidHookAddress. */
export function isValidHookAddress(addr: `0x${string}`): boolean {
  const bits = BigInt(addr)
  if ((bits & REQUIRED_FLAGS) !== REQUIRED_FLAGS) return false
  if ((bits & BEFORE_SWAP_DELTA_FLAG) !== 0n && (bits & BEFORE_SWAP_FLAG) === 0n) return false
  if ((bits & AFTER_SWAP_DELTA_FLAG)  !== 0n && (bits & AFTER_SWAP_FLAG)  === 0n) return false
  if ((bits & AFTER_ADD_DELTA_FLAG)   !== 0n && (bits & AFTER_ADD_FLAG)   === 0n) return false
  if ((bits & AFTER_REM_DELTA_FLAG)   !== 0n && (bits & AFTER_REM_FLAG)   === 0n) return false
  return true
}

// ── Genesis window (mirror of ToshLaunchpadHook's DURATION_* constants) ──────
// The hook's constructor rejects anything outside this set, and because the
// value is part of the initcode hash a salt is only valid for the window it was
// mined against.
export const GENESIS_DURATION_FAST = BigInt(3 * 60 * 60)
export const GENESIS_DURATION_STANDARD = BigInt(24 * 60 * 60)
export const GENESIS_DURATION_SLOW = BigInt(72 * 60 * 60)

/**
 * keccak256 of the hook deployment initcode (v5.0).
 *
 * initcode = hookBytecode
 *         ++ abi.encode(poolManager, factory, projectTreasury, creator,
 *                       projectAdmin, ladderTreasury, softCap, perWalletCap,
 *                       genesisDuration)
 *
 * Must match `HookDeployLib.computeInitcodeHash` bit-for-bit.  An extra or
 * missing field (the v4.x `satoToken` argument, a missing `perWalletCap`, the
 * wrong `genesisDuration`) yields a stale CREATE2 prediction and `createLaunch`
 * reverts with `InvalidHookSalt`.
 */
export function computeHookInitcodeHash(
  hookBytecode:    `0x${string}`,
  poolManager:     `0x${string}`,
  factory:         `0x${string}`,
  projectTreasury: `0x${string}`,
  creator:         `0x${string}`,
  projectAdmin:    `0x${string}`,
  ladderTreasury:  `0x${string}`,
  softCap:         bigint,
  perWalletCap:    bigint,
  genesisDuration: bigint,
): `0x${string}` {
  const encodedArgs = encodeAbiParameters(
    parseAbiParameters("address, address, address, address, address, address, uint256, uint256, uint256"),
    [
      poolManager, factory, projectTreasury, creator, projectAdmin, ladderTreasury,
      softCap, perWalletCap, genesisDuration,
    ]
  )
  const initcode = concat([hookBytecode, encodedArgs])
  return keccak256(initcode)
}

/** Convenience wrapper that hashes the bundled `HOOK_BYTECODE` artefact. */
export function computeBundledHookInitcodeHash(
  poolManager:     `0x${string}`,
  factory:         `0x${string}`,
  projectTreasury: `0x${string}`,
  creator:         `0x${string}`,
  projectAdmin:    `0x${string}`,
  ladderTreasury:  `0x${string}`,
  softCap:         bigint,
  perWalletCap:    bigint,
  genesisDuration: bigint,
): `0x${string}` {
  return computeHookInitcodeHash(
    HOOK_BYTECODE,
    poolManager, factory, projectTreasury, creator, projectAdmin, ladderTreasury,
    softCap, perWalletCap, genesisDuration,
  )
}

/**
 * Derive the creator-bound finalSalt used by ToshFactory.createLaunch.
 *
 *   bytes32 finalSalt = keccak256(abi.encode(creator, hookSalt));
 */
export function deriveFinalSalt(
  creator:  `0x${string}`,
  rawSalt:  `0x${string}`
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [creator, rawSalt]
    )
  )
}

/**
 * Mine a CREATE2 salt so the resulting hook address carries the v5.0 flag
 * mask 0x20CC.
 *
 * The factory derives `finalSalt = keccak256(abi.encode(creator, rawSalt))`.
 * This mines `rawSalt` (pass it to createLaunch as `hookSalt`) against
 * `initcodeHash` from `factory.hookInitcodeHash(treasury, creator, admin,
 * softCap, perWalletCap, genesisDuration)`.  The same `genesisDuration` must be
 * passed to `createLaunch`, or the prediction misses and it reverts with
 * `InvalidHookSalt`.
 */
export function mineHookSalt(
  factory:      `0x${string}`,
  creator:      `0x${string}`,
  initcodeHash: `0x${string}`,
  maxAttempts = 500_000
): { rawSalt: `0x${string}`; finalSalt: `0x${string}`; hookAddress: `0x${string}` } {
  for (let i = BigInt(0); i < BigInt(maxAttempts); i++) {
    const rawSalt = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`
    const finalSalt = deriveFinalSalt(creator, rawSalt)
    const addr = computeCreate2Address(factory, finalSalt, initcodeHash)
    if (isValidHookAddress(addr)) {
      return { rawSalt, finalSalt, hookAddress: addr }
    }
  }
  throw new Error(`HookMiner: no valid salt found within ${maxAttempts} attempts`)
}
