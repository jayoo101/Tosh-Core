/**
 * Pins every platform constant the frontend restates to the contract that
 * defines it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `src/lib/contracts.ts` carries about eighteen numbers under the heading
 * "mirroring the hook" — the genesis supply split, the tier ladder, the price
 * ceiling, the TWAP window, the launch window, the genesis durations — plus
 * `MIN_SOFT_CAP_PROD` and `MAX_COOLDOWN_SECONDS` from the factory, and
 * `pogQuota.ts` mirrors `MAX_SIG_VALIDITY`. Before this guard, exactly four of
 * them were checked against Solidity: `TICK_LOWER`, `TICK_UPPER`, `POOL_FEE` and
 * `TICK_SPACING`, by `scripts/checkPoolGeometry.mjs`. The rest were two
 * independent declarations of one number with nothing comparing them.
 *
 * That gap is not hypothetical. The PoG attestation TTL was the same shape — a
 * ceiling mirrored in TS, a margin worked out in one signer and not the other —
 * and it took an eth_call against a live factory to notice, because every test,
 * every guard and `tsc` passed while one of the two signers issued attestations
 * that reverted. A mirrored constant that nothing compares is not a constant, it
 * is a comment.
 *
 * ── What drift costs, by number ─────────────────────────────────────────────
 *
 * These are not display strings. `GENESIS_CLAIM_SUPPLY` and `GENESIS_LP_SUPPLY`
 * decide what a depositor is told they will receive; `TIER_COUNT`, `TIER_SIZE`
 * and `TIER_STEP_E18` are the ladder price the buy panel quotes; the genesis
 * durations go into the salt that `createLaunch` re-derives, so a wrong one
 * reverts `InvalidHookSalt` after the user has already mined; `MIN_SOFT_CAP_PROD`
 * decides which soft caps the form accepts before the chain rejects them.
 *
 * ── Ground truth ────────────────────────────────────────────────────────────
 *
 * Parsed out of `src/*.sol`. Most of these are `internal constant` with no
 * getter and no ABI entry, so reading the source is the only way to obtain them
 * without retyping them — and retyping them is the failure being prevented.
 *
 * The TS side is IMPORTED, not parsed, so what gets compared is the value the
 * app actually uses after its own arithmetic, not a literal that happens to sit
 * next to the right name.
 *
 *   npm run guard:constants
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GENESIS_SUPPLY, GENESIS_CLAIM_SUPPLY, GENESIS_LP_SUPPLY, BONDING_MAX,
  TIER_COUNT, TIER_SIZE, TIER_STEP_E18, MAX_TIERS_PER_TX,
  PRICE_CEILING_BPS, TWAP_WINDOW_SECONDS, LAUNCH_WINDOW_SECONDS, PLATFORM_TAX_BPS,
  TAX_BPS, PLATFORM_SWAP_FEE_BPS, REFERRAL_BPS, PROJECT_REFERRAL_SHARE_BPS,
  GENESIS_DURATIONS, MIN_SOFT_CAP_PROD, MAX_LAUNCH_FEE, MAX_COOLDOWN_SECONDS,
  MAX_DEFAULT_SOFT_CAP, MAX_POG_ALLOCATION_LIMIT,
  ADMIN_BATCH_MAX, DEAD_ADDRESS,
} from '../src/lib/contracts'
import {
  GENESIS_DURATION_FAST, GENESIS_DURATION_STANDARD, GENESIS_DURATION_SLOW,
} from '../src/app/lib/hookAddress'
import { SIG_VALIDITY_SECONDS } from '../src/app/lib/pogQuota'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = 'src/ToshLaunchpadHook.sol'
const FACTORY = 'src/ToshFactory.sol'

const problems: string[] = []
const fail = (m: string) => problems.push(m)

const sources = new Map<string, string>()
function source(rel: string): string {
  let s = sources.get(rel)
  if (s === undefined) {
    s = readFileSync(join(ROOT, rel), 'utf8')
    sources.set(rel, s)
  }
  return s
}

/**
 * Evaluate a Solidity constant initialiser.
 *
 * Deliberately narrow: integers with `_` separators, the `e18` scientific form,
 * the `ether` and time unit suffixes, and a product of two other constants
 * (`BONDING_MAX = TIER_COUNT * TIER_SIZE`). Anything else returns null and is
 * reported rather than guessed at, because a guard that silently mis-evaluates
 * the ground truth is worse than no guard.
 */
const TIME_UNITS: Record<string, bigint> = {
  seconds: 1n, minutes: 60n, hours: 3600n, days: 86_400n, weeks: 604_800n,
}

function evalSolidity(expr: string, rel: string): bigint | null {
  const raw = expr.trim().replace(/\s+/g, ' ')

  // Identifiers first, and before any `_` stripping: Solidity's digit separator
  // and its constant names use the same character, so stripping globally turns
  // `TIER_COUNT` into `TIERCOUNT` and the reference resolves nowhere.
  const product = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)$/)
  if (product) {
    const a = solidityConstant(product[1], rel)
    const b = solidityConstant(product[2], rel)
    return a === null || b === null ? null : a * b
  }

  // Only now is it safe to treat `_` as a digit separator.
  const e = raw.replace(/_/g, '')

  // `24 hours`, `7 days`
  const timed = e.match(/^(\d+)\s+(seconds|minutes|hours|days|weeks)$/)
  if (timed) return BigInt(timed[1]) * TIME_UNITS[timed[2]]

  // `0.01 ether`, `1 ether`
  const ether = e.match(/^(\d+(?:\.\d+)?)\s+ether$/)
  if (ether) {
    const [whole, frac = ''] = ether[1].split('.')
    if (frac.length > 18) return null
    return BigInt(whole + frac.padEnd(18, '0'))
  }

  // `8400000e18`
  const sci = e.match(/^(\d+)e(\d+)$/)
  if (sci) return BigInt(sci[1]) * 10n ** BigInt(sci[2])

  // plain integer
  if (/^\d+$/.test(e)) return BigInt(e)

  return null
}

const solCache = new Map<string, bigint | null>()

function solidityConstant(name: string, rel: string): bigint | null {
  const key = `${rel}:${name}`
  if (solCache.has(key)) return solCache.get(key)!

  const re = new RegExp(
    `\\bconstant\\s+${name}\\s*=\\s*([^;]+);`)
  const m = source(rel).match(re)
  let value: bigint | null = null
  if (!m) {
    fail(
      `${rel}: no \`constant ${name}\` found. If it was renamed or made mutable, update `
      + 'this guard deliberately — do not drop the field, it is the only thing holding '
      + 'the frontend copy to this contract.')
  } else {
    value = evalSolidity(m[1], rel)
    if (value === null) {
      fail(
        `${rel}: could not evaluate \`${name} = ${m[1].trim()}\`. Teach evalSolidity the `
        + 'new form rather than removing the check.')
    }
  }
  solCache.set(key, value)
  return value
}

interface Field {
  /** Solidity constant name. */
  sol: string
  /** Which contract defines it. */
  file: string
  /** The frontend's value, after whatever arithmetic it does. */
  ts: bigint
  /** Where the frontend keeps it, for the failure message. */
  where: string
  /** What a mismatch actually breaks. */
  cost: string
}

const FIELDS: Field[] = [
  { sol: 'GENESIS_SUPPLY', file: HOOK, ts: GENESIS_SUPPLY, where: 'contracts.GENESIS_SUPPLY',
    cost: 'the genesis allocation shown to depositors is not the one minted' },
  { sol: 'GENESIS_CLAIM_SUPPLY', file: HOOK, ts: GENESIS_CLAIM_SUPPLY, where: 'contracts.GENESIS_CLAIM_SUPPLY',
    cost: 'every claim estimate is wrong, in the direction of over-promising' },
  { sol: 'GENESIS_LP_SUPPLY', file: HOOK, ts: GENESIS_LP_SUPPLY, where: 'contracts.GENESIS_LP_SUPPLY',
    cost: 'the quoted opening price p0 = lpNative/GENESIS_LP_SUPPLY is wrong' },
  { sol: 'BONDING_MAX', file: HOOK, ts: BONDING_MAX, where: 'contracts.BONDING_MAX',
    cost: 'the ladder progress bar and the mintable ceiling disagree with the hook' },
  { sol: 'TIER_COUNT', file: HOOK, ts: BigInt(TIER_COUNT), where: 'contracts.TIER_COUNT',
    cost: 'the ladder has a different number of shelves than the buy panel prices' },
  { sol: 'TIER_SIZE', file: HOOK, ts: TIER_SIZE, where: 'contracts.TIER_SIZE',
    cost: 'each shelf sells a different quantity than quoted' },
  { sol: 'TIER_STEP_E18', file: HOOK, ts: BigInt(TIER_STEP_E18), where: 'contracts.TIER_STEP_E18',
    cost: 'quoted shelf prices diverge from the hook, compounding over 4000 shelves' },
  { sol: 'MAX_TIERS_PER_TX', file: HOOK, ts: BigInt(MAX_TIERS_PER_TX), where: 'contracts.MAX_TIERS_PER_TX',
    cost: 'the panel builds a mint that crosses more shelves than one tx allows, and reverts' },
  { sol: 'PRICE_CEILING_BPS', file: HOOK, ts: BigInt(PRICE_CEILING_BPS), where: 'contracts.PRICE_CEILING_BPS',
    cost: 'the UI mis-states where the ladder stops undercutting the pool' },
  { sol: 'TWAP_WINDOW', file: HOOK, ts: BigInt(TWAP_WINDOW_SECONDS), where: 'contracts.TWAP_WINDOW_SECONDS',
    cost: 'the displayed TWAP window is not the one the ceiling is measured over' },
  { sol: 'LAUNCH_WINDOW', file: HOOK, ts: LAUNCH_WINDOW_SECONDS, where: 'contracts.LAUNCH_WINDOW_SECONDS',
    cost: 'the refund/launch countdown expires at a different moment than the hook' },
  { sol: 'DURATION_FAST', file: HOOK, ts: GENESIS_DURATIONS.fast, where: 'contracts.GENESIS_DURATIONS.fast',
    cost: 'the mined salt encodes a duration createLaunch will not accept — InvalidHookSalt' },
  { sol: 'DURATION_STANDARD', file: HOOK, ts: GENESIS_DURATIONS.standard, where: 'contracts.GENESIS_DURATIONS.standard',
    cost: 'the mined salt encodes a duration createLaunch will not accept — InvalidHookSalt' },
  { sol: 'DURATION_SLOW', file: HOOK, ts: GENESIS_DURATIONS.slow, where: 'contracts.GENESIS_DURATIONS.slow',
    cost: 'the mined salt encodes a duration createLaunch will not accept — InvalidHookSalt' },
  // Do not confuse this with `TAX_BPS`, which is also 100 and is a different
  // levy on a different flow — see the note in ToshLaunchpadHook.sol. The name
  // in `sol` is matched whole, so the two cannot cross-resolve.
  { sol: 'PLATFORM_TAX_BPS', file: HOOK, ts: BigInt(PLATFORM_TAX_BPS), where: 'contracts.PLATFORM_TAX_BPS',
    cost: 'the detail page publishes the wrong split of a shelf mint — it states, as a figure, '
      + "what share of a buyer's ETH reaches the project" },
  // The three below are all disclosures of what trading costs. They are the
  // numbers a user is owed before they sign, so drift here is not a cosmetic
  // bug — it is the interface quoting a fee the chain does not charge.
  { sol: 'TAX_BPS', file: HOOK, ts: BigInt(TAX_BPS), where: 'contracts.TAX_BPS',
    cost: 'the project page understates or overstates total trader friction, which it '
      + 'publishes as a single percentage next to a buy button' },
  { sol: 'PLATFORM_SWAP_FEE_BPS', file: HOOK, ts: BigInt(PLATFORM_SWAP_FEE_BPS), where: 'contracts.PLATFORM_SWAP_FEE_BPS',
    cost: "the buy leg's split is misattributed — the share called platform revenue is not the one the hook pays out" },
  { sol: 'REFERRAL_BPS', file: HOOK, ts: BigInt(REFERRAL_BPS), where: 'contracts.REFERRAL_BPS',
    cost: 'the referral panel promises a cut the hook does not reserve' },
  { sol: 'PROJECT_REFERRAL_SHARE_BPS', file: HOOK, ts: BigInt(PROJECT_REFERRAL_SHARE_BPS),
    where: 'contracts.PROJECT_REFERRAL_SHARE_BPS',
    cost: 'the referral desk and the rebate page split the cut one way while the hook '
      + 'splits it another, so every sharer is quoted the wrong rate on the leg they '
      + 'are actually earning' },
  { sol: 'MIN_SOFT_CAP_PROD', file: FACTORY, ts: MIN_SOFT_CAP_PROD, where: 'contracts.MIN_SOFT_CAP_PROD',
    cost: 'the launch form accepts a soft cap the factory rejects, or blocks one it allows' },
  { sol: 'MAX_LAUNCH_FEE', file: FACTORY, ts: MAX_LAUNCH_FEE, where: 'contracts.MAX_LAUNCH_FEE',
    cost: 'the admin panel accepts a fee the factory reverts on with LaunchFeeTooHigh' },
  { sol: 'MAX_DEFAULT_SOFT_CAP', file: FACTORY, ts: MAX_DEFAULT_SOFT_CAP, where: 'contracts.MAX_DEFAULT_SOFT_CAP',
    cost: 'the admin panel accepts a soft cap the factory reverts on with SoftCapTooHigh' },
  { sol: 'MAX_POG_ALLOCATION_LIMIT', file: FACTORY, ts: MAX_POG_ALLOCATION_LIMIT, where: 'contracts.MAX_POG_ALLOCATION_LIMIT',
    cost: 'the admin panel accepts a wallet cap the factory reverts on with PogLimitTooHigh' },
  { sol: 'MAX_COOLDOWN', file: FACTORY, ts: BigInt(MAX_COOLDOWN_SECONDS), where: 'contracts.MAX_COOLDOWN_SECONDS',
    cost: 'the admin panel offers a cooldown the factory reverts on' },
  { sol: 'MAX_SIG_VALIDITY', file: FACTORY, ts: BigInt(SIG_VALIDITY_SECONDS), where: 'pogQuota.SIG_VALIDITY_SECONDS',
    cost: 'attestations are signed against the wrong ceiling — SignatureTooLong on every registration' },
]

for (const f of FIELDS) {
  const truth = solidityConstant(f.sol, f.file)
  if (truth === null) continue
  if (truth !== f.ts) {
    fail(
      `${f.sol}: ${f.file} says ${truth}, ${f.where} says ${f.ts}.\n`
      + `    Consequence: ${f.cost}.\n`
      + '    The contract is authoritative — it is what the chain executes.')
  }
}

// ─── Second copies of the genesis durations ──────────────────────────────────
// `hookAddress.ts` keeps its own set, because address prediction needs them as
// bigints. Two copies of three numbers in the same package is how the ladder
// guard would go green while the launch path stayed broken.
//
// THE CONSEQUENCE GOT WORSE, not better, when the address miner was removed.
// A duration mismatch used to re-roll the CREATE2 address, fail Uniswap V4's
// permission mask and revert `InvalidHookSalt`. Infinity has no mask, so the
// launch now succeeds at an address the UI never predicted, with the wrong
// genesis window baked into the clone's immutable args.
const PREDICTOR: Array<[string, bigint, bigint]> = [
  ['fast', GENESIS_DURATION_FAST, GENESIS_DURATIONS.fast],
  ['standard', GENESIS_DURATION_STANDARD, GENESIS_DURATIONS.standard],
  ['slow', GENESIS_DURATION_SLOW, GENESIS_DURATIONS.slow],
]
for (const [label, predictor, contractsCopy] of PREDICTOR) {
  if (predictor !== contractsCopy) {
    fail(
      `genesis duration "${label}": HookAddress says ${predictor}, contracts says ${contractsCopy}.\n`
      + '    Consequence: the address is predicted against one duration and the launch is '
      + 'submitted with the other, so the hook deploys somewhere the UI cannot name — '
      + 'silently, since there is no permission mask left to reject it.')
  }
}

// ─── The admin batch cap, which is a literal in a require ────────────────────
// Not a named constant on-chain, so it is matched where it is enforced. The
// admin panel batches exactly this many rows per transaction; if the contract
// allows fewer, every full batch reverts with "Batch too large".
{
  const m = source(FACTORY).match(/users\.length\s*<=\s*(\d+)/)
  if (!m) {
    fail(
      `${FACTORY}: could not find the \`users.length <= N\` batch bound that `
      + 'contracts.ADMIN_BATCH_MAX mirrors. If the bound moved, point this guard at it.')
  } else if (BigInt(m[1]) !== BigInt(ADMIN_BATCH_MAX)) {
    fail(
      `ADMIN_BATCH_MAX: ${FACTORY} allows ${m[1]} per call, contracts says ${ADMIN_BATCH_MAX}.\n`
      + '    Consequence: the admin panel builds blacklist batches the factory reverts on.')
  }
}

// ─── The burn address ────────────────────────────────────────────────────────
{
  const m = source(HOOK).match(/constant\s+DEAD_ADDRESS\s*=\s*(0x[0-9a-fA-F]{40})/)
  if (!m) {
    fail(`${HOOK}: no \`constant DEAD_ADDRESS\` found.`)
  } else if (m[1].toLowerCase() !== DEAD_ADDRESS.toLowerCase()) {
    fail(
      `DEAD_ADDRESS: ${HOOK} says ${m[1]}, contracts says ${DEAD_ADDRESS}.\n`
      + '    Consequence: the UI reports burns to an address that never received them.')
  }
}

if (problems.length > 0) {
  console.error('\n[checkContractConstants] FAILED — the frontend no longer mirrors the contracts:\n')
  for (const p of problems) console.error('  • ' + p + '\n')
  process.exit(1)
}

console.log(
  `[checkContractConstants] OK — ${FIELDS.length} constants, 3 genesis durations, `
  + 'the batch cap and the burn address all match src/*.sol '
  + '(pool geometry is covered by checkPoolGeometry.mjs)')
