import { keccak256, encodeAbiParameters, concat, numberToHex } from "viem"

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
// `initializeToken` rejects anything outside this set, and because the value is
// baked into the clone's bytecode it is part of the initcode hash — so a salt is
// only valid for the window it was mined against.
export const GENESIS_DURATION_FAST = BigInt(3 * 60 * 60)
export const GENESIS_DURATION_STANDARD = BigInt(24 * 60 * 60)
export const GENESIS_DURATION_SLOW = BigInt(72 * 60 * 60)

/** Total length of a hook clone's CREATE2 initcode, in bytes. */
export const CLONE_INITCODE_BYTES = 131

/**
 * Build the CREATE2 initcode for a project's hook.
 *
 * A hook is a 121-byte EIP-1167 minimal proxy with its per-project
 * configuration appended to its own runtime bytecode — NOT a fresh ~19.6 KB copy
 * of the hook, which is what this used to be. That change took `createLaunch`
 * from 5,016,031 gas to roughly 1.2 M, and it changed the initcode completely:
 *
 *     10 B  creation stub, returning the 121 (0x79) bytes that follow
 *     45 B  EIP-1167 runtime, implementation address at offset 10
 *     76 B  immutable args: creator, projectTreasury, softCap:uint128,
 *           perWalletCap:uint128, genesisDuration:uint32
 *
 * Note what is NOT in here. `poolManager`, `factory` and `ladderTreasury` are
 * identical for every launch and so are ordinary immutables on the shared
 * implementation. `projectAdmin` is mutable by design and is applied by
 * `initializeToken`, so it no longer moves the mined address.
 *
 * Must match `ToshCloneLib.cloneInitcode` byte for byte;
 * `test_hookInitcodeHash_matchesHandBuiltCloneInitcode` pins the two together.
 * Anything else yields a stale CREATE2 prediction and `createLaunch` reverts
 * with `InvalidHookSalt`.
 *
 * @param implementation `factory.hookImplementation()`.
 */
export function computeCloneInitcode(
  implementation:  `0x${string}`,
  creator:         `0x${string}`,
  projectTreasury: `0x${string}`,
  softCap:         bigint,
  perWalletCap:    bigint,
  genesisDuration: bigint,
): `0x${string}` {
  if (softCap >= 1n << 128n || perWalletCap >= 1n << 128n) {
    throw new Error("hookMiner: softCap / perWalletCap must fit in uint128")
  }
  if (genesisDuration >= 1n << 32n) {
    throw new Error("hookMiner: genesisDuration must fit in uint32")
  }

  return concat([
    "0x3d607980600a3d3981f3",
    "0x363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
    creator,
    projectTreasury,
    numberToHex(softCap, { size: 16 }),
    numberToHex(perWalletCap, { size: 16 }),
    numberToHex(genesisDuration, { size: 4 }),
  ])
}

/**
 * keccak256 of the clone initcode — the value salts are mined against.
 *
 * Prefer reading `factory.hookInitcodeHash(...)` on-chain; that is authoritative
 * and cannot drift. This exists to verify the chain's answer, and to mine
 * offline.
 */
export function computeHookInitcodeHash(
  implementation:  `0x${string}`,
  creator:         `0x${string}`,
  projectTreasury: `0x${string}`,
  softCap:         bigint,
  perWalletCap:    bigint,
  genesisDuration: bigint,
): `0x${string}` {
  return keccak256(
    computeCloneInitcode(implementation, creator, projectTreasury, softCap, perWalletCap, genesisDuration)
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
 * `initcodeHash` from `factory.hookInitcodeHash(projectTreasury, creator,
 * softCap, perWalletCap, genesisDuration)`.  The same `genesisDuration` must be
 * passed to `createLaunch`, or the prediction misses and it reverts with
 * `InvalidHookSalt`.
 *
 * Difficulty is a property of the 0x20CC mask — five required bits, so about one
 * salt in 32 — and not of the initcode. Shrinking the hook to a clone made the
 * deployment ~70x cheaper but did not make mining any easier or harder.
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
