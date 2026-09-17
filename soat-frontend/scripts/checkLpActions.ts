/**
 * Validates the posm payloads built by `src/lib/lpActions.ts` against the
 * rules `CLPositionManager` enforces when it decodes them: STRICT abi encoding
 * (`CalldataDecoder.decodeActionsRouterParams` recomputes every offset and
 * reverts on any deviation) and the hard-coded field offsets
 * `decodeCLMintParams` / `decodeCLBurnParams` read.
 *
 * Getting this wrong produces a transaction that reverts with an opaque
 * `SliceOutOfBounds`, which is a miserable thing to debug from a wallet popup.
 *
 *   npm run guard:lpactions
 *
 * ── What this half does and does not pin ────────────────────────────────────
 *
 * It runs the REAL encoder — viem, the same call the panel makes — and checks
 * the actual bytes. What it cannot do is know whether the offsets it expects
 * are the ones the vendored decoder reads, because the expectations below are
 * numbers written here. A submodule bump that moved `decodeCLMintParams`'s
 * offsets, added a `PoolKey` field, or renumbered an `Actions` opcode would
 * leave every line below green.
 *
 * `scripts/checkLpActionsAbi.mjs` closes exactly that gap: it parses
 * `lib/infinity-periphery` and `lib/infinity-core` and requires the literals
 * here and the frontend's param specs to agree with the Solidity. It runs in
 * test.yml, which is the job that checks out submodules. Both must stay wired
 * up; neither is sufficient alone.
 *
 * Note the opcodes below are LITERALS, deliberately. Asserting them against
 * `CL_ACTIONS` — the same constant `lpActions.ts` builds the payload from —
 * is a tautology that passes for any value, which is what this used to do.
 *
 * ⚠ THE OPCODES ARE NUMERICALLY IDENTICAL TO UNISWAP V4'S. The six-member
 *   PoolKey is the only structural signal that this payload is Infinity's.
 *   A five-slot mint layout here would encode a well-formed V4 payload against
 *   an Infinity decoder and fail late, or mint into a pool nobody asked for.
 */

import { encodeMintPayload, encodeBurnPayload } from '../src/lib/lpActions'
import { TICK_LOWER, TICK_UPPER, POOL_FEE, TICK_SPACING, CL_POOL_MANAGER } from '../src/lib/contracts'

/** infinity-periphery `Actions`, as of the pinned submodule. Verified by checkLpActionsAbi.mjs. */
const CL_MINT_POSITION = 0x02
const CL_BURN_POSITION = 0x03
const SETTLE_PAIR = 0x0d
const TAKE_PAIR = 0x11
const SWEEP = 0x14

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const HOOK  = '0x22222222222222222222222222222222222222C8' as const
const OWNER = '0x3333333333333333333333333333333333333333' as const

/**
 * Production Tosh bitmap: offsets 0, 2, 6, 7, 10, 11 → 0x0CC5.
 * A fixture for the encoder, not a default the panel types in; the panel reads
 * `getHooksRegistrationBitmap()` off the deployed hook.
 */
const HOOKS_BITMAP = 0x0cc5
const PARAMETERS = BigInt(HOOKS_BITMAP) | (BigInt(TICK_SPACING) << 16n)

let failures = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) { failures++; console.log(`FAIL  ${label}\n        got  ${got}\n        want ${want}`) }
  else console.log(`ok    ${label}`)
}

/** Split a 0x blob into 32-byte words. */
function words(hex: string): bigint[] {
  const body = hex.slice(2)
  const out: bigint[] = []
  for (let i = 0; i < body.length; i += 64) out.push(BigInt('0x' + body.slice(i, i + 64)))
  return out
}

const ceil32 = (n: number) => Math.ceil(n / 32) * 32

/**
 * Mirrors `decodeActionsRouterParams`.  Returns the decoded action opcodes and
 * each param blob, throwing on exactly the conditions that make posm revert.
 */
function decodeStrict(payload: string): { actions: number[]; params: string[] } {
  const w = words(payload)
  const body = Buffer.from(payload.slice(2), 'hex')

  if (w[0] !== 0x40n) throw new Error(`word0 must be 0x40, got 0x${w[0].toString(16)}`)

  const actionsLen = Number(w[2])
  const actionsBytes = body.subarray(0x60, 0x60 + actionsLen)

  const expectedParamsOffset = BigInt(ceil32(actionsLen) + 0x60)
  if (w[1] !== expectedParamsOffset) {
    throw new Error(`word1 must be ${expectedParamsOffset}, got ${w[1]}`)
  }

  const paramsLenPtr = Number(expectedParamsOffset)
  const paramsLen = Number(BigInt('0x' + body.subarray(paramsLenPtr, paramsLenPtr + 32).toString('hex')))
  const paramsBase = paramsLenPtr + 32

  // Every head slot must equal the tight running offset, exactly as the
  // decoder recomputes it.
  let expectedOffset = paramsLen * 32
  const params: string[] = []
  for (let i = 0; i < paramsLen; i++) {
    const head = Number(BigInt('0x' + body.subarray(paramsBase + i * 32, paramsBase + i * 32 + 32).toString('hex')))
    if (head !== expectedOffset) {
      throw new Error(`params[${i}] head is ${head}, strict encoding needs ${expectedOffset}`)
    }
    const lenPtr = paramsBase + head
    const len = Number(BigInt('0x' + body.subarray(lenPtr, lenPtr + 32).toString('hex')))
    params.push('0x' + body.subarray(lenPtr + 32, lenPtr + 32 + len).toString('hex'))
    expectedOffset += ceil32(len) + 32
  }

  if (body.length < paramsBase + expectedOffset) throw new Error('payload shorter than its own encoding claims')

  return { actions: [...actionsBytes], params }
}

if (/^0x0{40}$/.test(CL_POOL_MANAGER)) {
  failures++
  console.log(
    'FAIL  CL_POOL_MANAGER is the zero sentinel — encodeMintPayload will throw rather than ' +
    'build a key. runTsGuard should pin NEXT_PUBLIC_CHAIN_ID to 97 or 56.',
  )
}

// ── MINT ─────────────────────────────────────────────────────────────────────
console.log('CL_MINT_POSITION + SETTLE_PAIR + SWEEP')

const mintPayload = encodeMintPayload({
  token: TOKEN, hook: HOOK, hooksRegistrationBitmap: HOOKS_BITMAP, owner: OWNER,
  liquidity: 76_376_261_582_597_339_790n,
  amount0Max: 50_250_000_000_000_000n,
  amount1Max: 117_250_000_000_000_000_000_000n,
})

const mint = decodeStrict(mintPayload)
check('strict encoding accepted by decodeActionsRouterParams', true, true)
check('action opcodes', mint.actions.join(','),
  [CL_MINT_POSITION, SETTLE_PAIR, SWEEP].join(','))
check('three param blobs', mint.params.length, 3)

// decodeCLMintParams reads by fixed slot: PoolKey occupies 0..5 because it is a
// fully static six-member tuple, so hookData's head has to land on slot 12
// (toBytes(12) → 13 * 32 = 416).
const mp = words(mint.params[0])
check('slot0  poolKey.currency0 == native', mp[0], 0n)
check('slot1  poolKey.currency1 == token', '0x' + mp[1].toString(16).padStart(40, '0'), TOKEN)
check('slot2  poolKey.hooks', '0x' + mp[2].toString(16).padStart(40, '0'), HOOK.toLowerCase())
check('slot3  poolKey.poolManager', '0x' + mp[3].toString(16).padStart(40, '0'), CL_POOL_MANAGER.toLowerCase())
check('slot4  poolKey.fee', mp[4], BigInt(POOL_FEE))
check('slot5  poolKey.parameters (bitmap | tickSpacing << 16)', mp[5], PARAMETERS)
check('slot6  tickLower (0xc0)', BigInt.asIntN(256, mp[6]), BigInt(TICK_LOWER))
check('slot7  tickUpper (0xe0)', BigInt.asIntN(256, mp[7]), BigInt(TICK_UPPER))
check('slot8  liquidity (0x100)', mp[8], 76_376_261_582_597_339_790n)
check('slot9  amount0Max (0x120)', mp[9], 50_250_000_000_000_000n)
check('slot10 amount1Max (0x140)', mp[10], 117_250_000_000_000_000_000_000n)
check('slot11 owner (0x160)', '0x' + mp[11].toString(16).padStart(40, '0'), OWNER)
check('slot12 hookData head — the slot toBytes(12) reads', mp[12], 416n)
check('hookData is empty', mp[13], 0n)
check('mint params occupy 14 words, not V4\'s 13', mp.length, 14)

const settle = words(mint.params[1])
check('SETTLE_PAIR currency0 == native', settle[0], 0n)
check('SETTLE_PAIR currency1 == token', '0x' + settle[1].toString(16).padStart(40, '0'), TOKEN)

const sweep = words(mint.params[2])
check('SWEEP currency == native', sweep[0], 0n)
check('SWEEP recipient == owner', '0x' + sweep[1].toString(16).padStart(40, '0'), OWNER)

// ── BURN ─────────────────────────────────────────────────────────────────────
console.log('\nCL_BURN_POSITION + TAKE_PAIR')

const burnPayload = encodeBurnPayload({
  token: TOKEN, recipient: OWNER, tokenId: 7n,
  amount0Min: 49_000_000_000_000_000n,
  amount1Min: 116_000_000_000_000_000_000_000n,
})

const burn = decodeStrict(burnPayload)
check('action opcodes', burn.actions.join(','),
  [CL_BURN_POSITION, TAKE_PAIR].join(','))
check('two param blobs', burn.params.length, 2)

const bp = words(burn.params[0])
check('slot0 tokenId', bp[0], 7n)
check('slot1 amount0Min (0x20)', bp[1], 49_000_000_000_000_000n)
check('slot2 amount1Min (0x40)', bp[2], 116_000_000_000_000_000_000_000n)
check('slot3 hookData head — the slot toBytes(3) reads', bp[3], 128n)

const take = words(burn.params[1])
check('TAKE_PAIR currency0 == native', take[0], 0n)
check('TAKE_PAIR currency1 == token', '0x' + take[1].toString(16).padStart(40, '0'), TOKEN)
check('TAKE_PAIR recipient', '0x' + take[2].toString(16).padStart(40, '0'), OWNER)

console.log(failures === 0 ? '\nAll posm payload invariants hold.' : `\n${failures} mismatch(es).`)
process.exit(failures === 0 ? 0 : 1)
