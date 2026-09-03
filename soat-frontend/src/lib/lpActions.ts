// ─────────────────────────────────────────────────────────────────────────────
// posm action payload construction.
//
// `PositionManager.modifyLiquidities` takes an abi-encoded `(bytes actions,
// bytes[] params)` blob, where `actions` is a PACKED string of one-byte
// opcodes and `params[i]` carries that action's arguments.
//
// Two things make this worth isolating in pure functions rather than inlining
// in the component:
//
//   • `CalldataDecoder.decodeActionsRouterParams` enforces STRICT abi encoding
//     — it recomputes every offset and reverts on any deviation, including the
//     perfectly-legal-but-non-canonical layouts some encoders emit.
//   • `decodeMintParams` reads its fields by hard-coded calldata offsets, so
//     the argument list has to produce exactly the head layout it expects
//     (the PoolKey tuple is static and occupies slots 0..4, which is why
//     `hookData` lands at slot 11).
//
// Both properties are pinned by a pair of guards, and it takes both:
// `scripts/checkLpActions.ts` runs the real encoder and checks the bytes it
// emits, but only against offsets written in that file, so
// `scripts/checkLpActionsAbi.mjs` (repo root, runs in test.yml) is what holds
// those offsets and the `Actions` opcodes against the vendored Solidity in
// `lib/v4-periphery`. Move a `decodeMintParams` offset and the first guard
// alone still passes.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem'

import { TICK_LOWER, TICK_UPPER, V4_ACTIONS } from './contracts'
import { NATIVE_CURRENCY, POOL_KEY_PARAM, toshPoolKey } from './v4Math'

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
 * MINT_POSITION + SETTLE_PAIR + SWEEP.
 *
 * SWEEP returns whatever the pool did not take on the ETH leg, so the caller
 * can safely send `amount0Max` as `msg.value` and let the difference bounce.
 */
export function encodeMintPayload(args: {
  token: Address
  hook: Address
  owner: Address
  liquidity: bigint
  amount0Max: bigint
  amount1Max: bigint
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.SWEEP],
  )

  const mint = encodeAbiParameters(MINT_PARAM_SPEC, [
    toshPoolKey(args.token, args.hook),
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

/** BURN_POSITION + TAKE_PAIR — closes the position and pays both legs out. */
export function encodeBurnPayload(args: {
  token: Address
  recipient: Address
  tokenId: bigint
  amount0Min: bigint
  amount1Min: bigint
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [V4_ACTIONS.BURN_POSITION, V4_ACTIONS.TAKE_PAIR],
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
