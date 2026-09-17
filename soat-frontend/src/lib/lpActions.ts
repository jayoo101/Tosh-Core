// ─────────────────────────────────────────────────────────────────────────────
// posm action payload construction.
//
// `CLPositionManager.modifyLiquidities` takes an abi-encoded `(bytes actions,
// bytes[] params)` blob, where `actions` is a PACKED string of one-byte
// opcodes and `params[i]` carries that action's arguments.
//
// Two things make this worth isolating in pure functions rather than inlining
// in the component:
//
//   • `CalldataDecoder.decodeActionsRouterParams` enforces STRICT abi encoding
//     — it recomputes every offset and reverts on any deviation, including the
//     perfectly-legal-but-non-canonical layouts some encoders emit.
//   • `decodeCLMintParams` reads its fields by hard-coded calldata offsets, so
//     the argument list has to produce exactly the head layout it expects
//     (the PoolKey tuple is static and occupies slots 0..5, which is why
//     `hookData` lands at slot 12).
//
// ── THE OFFSETS, AND WHY THEY ARE NOT V4'S ─────────────────────────────────
//
// Every field after the key shifts one slot relative to Uniswap V4, because
// Infinity's `PoolKey` has six members where V4's had five.  From
// `lib/infinity-periphery/src/pool-cl/libraries/CLCalldataDecoder.sol`:
//
//     field         Infinity offset (slot)   V4 offset (slot)
//     PoolKey       0x00–0xa0        (0–5)   0x00–0x80    (0–4)
//     tickLower     0xc0             (6)     0xa0         (5)
//     tickUpper     0xe0             (7)     0xc0         (6)
//     liquidity     0x100            (8)     0xe0         (7)
//     amount0Max    0x120            (9)     0x100        (8)
//     amount1Max    0x140            (10)    0x120        (9)
//     owner         0x160            (11)    0x140        (10)
//     hookData      toBytes(12)              toBytes(11)
//
// `decodeCLBurnParams` is UNCHANGED from V4: tokenId 0x00, amount0Min 0x20,
// amount1Min 0x40, `hookData = toBytes(3)`.
//
// ⚠ THE ACTION OPCODES CANNOT TELL THE TWO APART. All five values coincide
//   between the peripheries, so the `actions` string is byte-identical for a V4
//   payload and an Infinity one and the PoolKey width is the ONLY structural
//   signal.  A half-done port therefore produces a payload that looks plausible
//   and fails late, or mints into a pool nobody asked for.  See `CL_ACTIONS` in
//   contracts.ts.
//
// Both properties are pinned by a pair of guards, and it takes both:
// `scripts/checkLpActions.ts` runs the real encoder and checks the bytes it
// emits, but only against offsets written in that file, so
// `scripts/checkLpActionsAbi.mjs` (repo root, runs in test.yml) is what holds
// those offsets and the `Actions` opcodes against the vendored Solidity in
// `lib/infinity-periphery`. Move a `decodeCLMintParams` offset and the first
// guard alone still passes.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem'

import { TICK_LOWER, TICK_UPPER, CL_ACTIONS } from './contracts'
import { NATIVE_CURRENCY, POOL_KEY_PARAM, toshPoolKey } from './clMath'

const MINT_PARAM_SPEC = [
  POOL_KEY_PARAM,
  { type: 'int24' }, { type: 'int24' }, { type: 'uint256' },
  { type: 'uint128' }, { type: 'uint128' },
  { type: 'address' }, { type: 'bytes' },
] as const

const BURN_PARAM_SPEC = [
  { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' },
] as const

const UNLOCK_SPEC = [{ type: 'bytes' }, { type: 'bytes[]' }] as const

/**
 * CL_MINT_POSITION + SETTLE_PAIR + SWEEP.
 *
 * SWEEP returns whatever the pool did not take on the ETH leg, so the caller
 * can safely send `amount0Max` as `msg.value` and let the difference bounce.
 *
 * `hooksRegistrationBitmap` is `hook.getHooksRegistrationBitmap()`, read off
 * the chain by the caller and threaded through into `PoolKey.parameters`. It is
 * a required argument rather than a defaulted one: `toshPoolKey` refuses a zero
 * bitmap, because zero is what an unresolved read looks like and it encodes a
 * key that is well-formed and wrong.
 */
export function encodeMintPayload(args: {
  token: Address
  hook: Address
  hooksRegistrationBitmap: number
  owner: Address
  liquidity: bigint
  amount0Max: bigint
  amount1Max: bigint
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [CL_ACTIONS.CL_MINT_POSITION, CL_ACTIONS.SETTLE_PAIR, CL_ACTIONS.SWEEP],
  )

  const mint = encodeAbiParameters(MINT_PARAM_SPEC, [
    toshPoolKey(args.token, args.hook, args.hooksRegistrationBitmap),
    TICK_LOWER, TICK_UPPER,
    args.liquidity, args.amount0Max, args.amount1Max,
    args.owner, '0x',
  ])
  const settle = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [NATIVE_CURRENCY, args.token],
  )
  const sweep = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [NATIVE_CURRENCY, args.owner],
  )

  return encodeAbiParameters(UNLOCK_SPEC, [actions, [mint, settle, sweep]])
}

/**
 * CL_BURN_POSITION + TAKE_PAIR — closes the position and pays both legs out.
 *
 * No pool key and therefore no bitmap: `decodeCLBurnParams` takes the tokenId,
 * and its layout is byte-for-byte what V4's `decodeBurnParams` took.
 */
export function encodeBurnPayload(args: {
  token: Address
  recipient: Address
  tokenId: bigint
  amount0Min: bigint
  amount1Min: bigint
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [CL_ACTIONS.CL_BURN_POSITION, CL_ACTIONS.TAKE_PAIR],
  )

  const burn = encodeAbiParameters(BURN_PARAM_SPEC, [
    args.tokenId, args.amount0Min, args.amount1Min, '0x',
  ])
  const take = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [NATIVE_CURRENCY, args.token, args.recipient],
  )

  return encodeAbiParameters(UNLOCK_SPEC, [actions, [burn, take]])
}
