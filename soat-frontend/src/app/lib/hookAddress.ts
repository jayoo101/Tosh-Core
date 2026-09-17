import { keccak256, encodeAbiParameters, concat, numberToHex } from "viem"

// ⚠ THERE IS NO MINER IN HERE ANY MORE, and the file keeps its name only until a
//   rename can be done on its own. What survives is address PREDICTION, which the
//   launch page still needs; what went is the search.
//
//   Uniswap V4 read a hook's permissions out of the low bits of its own address,
//   so a launch had to arrive with a salt whose CREATE2 address carried the
//   0x20CC mask — five required bits, about one salt in 32, hence `mineHookSalt`
//   and its 500,000-attempt budget. PancakeSwap Infinity asks the contract
//   instead, via `getHooksRegistrationBitmap()`, and `CLPoolManager.initialize`
//   refuses a pool whose `PoolKey.parameters` disagrees with the answer.
//   `ToshFactory` checks no address bits, `HookMiner.isValidHookAddress` was
//   deleted from Solidity, and there is nothing left for a salt to satisfy.
//
//   Deleted with it: REQUIRED_FLAGS, isValidHookAddress, and the eight flag
//   constants. Keeping them as documentation would have been worse than removing
//   them — they described a rule the chain no longer applies.

/** Replicates Solidity create2 address derivation. */
export function computeCreate2Address(
  deployer:     `0x${string}`,
  salt:         `0x${string}`,
  initcodeHash: `0x${string}`
): `0x${string}` {
  const hash = keccak256(concat(["0xff", deployer, salt, initcodeHash]))
  return `0x${hash.slice(26)}` as `0x${string}`
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
 *
 * ⚠ Getting this wrong is now SILENT. It used to yield a stale CREATE2
 *   prediction and `createLaunch` reverted `InvalidHookSalt`, because the
 *   re-rolled address almost never carried the permission mask. With the mask
 *   gone the launch succeeds at an address nobody predicted, so the check that
 *   matters is comparing this against `factory.hookInitcodeHash` — which the
 *   launch page reads on-chain and uses in preference to this.
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
 * Pick a CREATE2 salt and report where it lands.
 *
 * ⚠ REPLACES `mineHookSalt`, WHICH SEARCHED. There is nothing to search for: see
 *   the note at the top of this file. A salt's only remaining job is to be
 *   unused, and that is a property of the address it produces rather than of the
 *   salt, so this returns the prediction and leaves the occupancy check to the
 *   caller — only an RPC can answer it, and this module is deliberately pure.
 *
 * The salt is 32 random bytes rather than a counter from zero. Counting up is
 * what the miner did, and it was safe there because the mask made an early
 * collision vanishingly unlikely; without the mask, the first free salt for one
 * creator is `0x00..00` every time, so two launches by the same creator with the
 * same dials and window would predict the same address and the second CREATE2
 * would fail. Randomness sidesteps that without needing to know how many times
 * this creator has launched before.
 *
 * The factory derives `finalSalt = keccak256(abi.encode(creator, rawSalt))`, and
 * `initcodeHash` should come from `factory.hookInitcodeHash(projectTreasury,
 * creator, softCap, perWalletCap, genesisDuration)`. The same `genesisDuration`,
 * `softCap` and `perWalletCap` must reach `createLaunch` — the first because it is
 * in the initcode hash, the latter two because `expectedSoftCap` /
 * `expectedWalletCap` are checked for equality and the launch reverts
 * `CapsChanged` otherwise.
 */
export function pickHookSalt(
  factory:      `0x${string}`,
  creator:      `0x${string}`,
  initcodeHash: `0x${string}`
): { rawSalt: `0x${string}`; finalSalt: `0x${string}`; hookAddress: `0x${string}` } {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const rawSalt = `0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`

  const finalSalt = deriveFinalSalt(creator, rawSalt)
  return { rawSalt, finalSalt, hookAddress: computeCreate2Address(factory, finalSalt, initcodeHash) }
}
