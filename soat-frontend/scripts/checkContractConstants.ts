/**
 * Pins every protocol constant the frontend restates to the contract that
 * defines it.
 *
 * `src/lib/v2/config.ts` carries the numbers the UI computes with — the bid
 * book's fee and fill floor, the genesis supplies, the admin launch window.
 * A mirrored constant that nothing compares is not a constant, it is a
 * comment: every test, every guard and `tsc` pass while the UI quotes a figure
 * the chain does not use.
 *
 * Ground truth is parsed out of `src/*.sol`, because several of these are
 * `internal constant` with no getter. The TS side is IMPORTED, not parsed, so
 * what gets compared is the value the app actually uses.
 *
 *   npm run guard:constants
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STACK_SUPPLY, V2 } from '../src/lib/v2/config'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const V2_HOOK = 'src/ToshLaunchpadHook.sol'
const V2_BOOK = 'src/ToshBidBook.sol'
const CURVE = 'src/libraries/GenesisCurve.sol'
const V3_HOOK = 'src/v3/ToshLaunchpadHookV3.sol'
const V3_CURVE = 'src/v3/libraries/GenesisCurveV3.sol'

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

  // `500 * QUOTE_UNIT` — a literal count of a named unit.
  const scaled = raw.match(/^([\d_]+)\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)$/)
  if (scaled) {
    const unit = solidityConstant(scaled[2], rel)
    return unit === null ? null : BigInt(scaled[1].replace(/_/g, '')) * unit
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
  { sol: 'FEE_BPS', file: V2_BOOK, ts: V2.FEE_BPS, where: 'v2/config.V2.FEE_BPS',
    cost: 'the bid form locks too little escrow and placeBid pulls more than was approved' },
  { sol: 'FILL_FLOOR_BPS', file: V2_BOOK, ts: V2.FILL_FLOOR_BPS, where: 'v2/config.V2.FILL_FLOOR_BPS',
    cost: 'the sell preview routes into bids the book skips, and the sale reverts NothingFilled' },
  { sol: 'MIN_FILL_QTY', file: V2_BOOK, ts: V2.MIN_FILL_QTY, where: 'v2/config.V2.MIN_FILL_QTY',
    cost: 'the bid form accepts a quantity placeBid rejects' },
  { sol: 'ADMIN_LAUNCH_WINDOW', file: V2_HOOK, ts: BigInt(V2.ADMIN_LAUNCH_WINDOW_S), where: 'v2/config.V2.ADMIN_LAUNCH_WINDOW_S',
    cost: 'the launch panel tells the public it may launch while the hook still reserves it for the NFT holder' },
  { sol: 'GENESIS_SUPPLY', file: V2_HOOK, ts: V2.GENESIS_SUPPLY, where: 'v2/config.V2.GENESIS_SUPPLY',
    cost: 'the v2 progress bar measures sales against the wrong supply' },
  { sol: 'SALE_SUPPLY', file: CURVE, ts: V2.SALE_SUPPLY, where: 'v2/config.V2.SALE_SUPPLY',
    cost: 'the genesis buy panel prices against a curve that sells a different supply' },
  { sol: 'FUND_BPS', file: V2_HOOK, ts: V2.FUND_BPS, where: 'v2/config.V2.FUND_BPS',
    cost: 'the raise breakdown misstates the share routed to the project fund' },
  // Both stacks, whichever NEXT_PUBLIC_TOSH_STACK this run was built for.
  { sol: 'GENESIS_SUPPLY', file: V2_HOOK, ts: STACK_SUPPLY.v2.GENESIS_SUPPLY, where: 'v2/config.STACK_SUPPLY.v2.GENESIS_SUPPLY',
    cost: 'a v2 build measures sales against the wrong supply' },
  { sol: 'SALE_SUPPLY', file: CURVE, ts: STACK_SUPPLY.v2.SALE_SUPPLY, where: 'v2/config.STACK_SUPPLY.v2.SALE_SUPPLY',
    cost: 'a v2 build prices against a curve that sells a different supply' },
  { sol: 'TIER_COUNT', file: V2_HOOK, ts: BigInt(STACK_SUPPLY.v2.TIER_COUNT), where: 'v2/config.STACK_SUPPLY.v2.TIER_COUNT',
    cost: 'a v2 build numbers the shelves out of the wrong total' },
  { sol: 'GENESIS_SUPPLY', file: V3_HOOK, ts: STACK_SUPPLY.v3.GENESIS_SUPPLY, where: 'v2/config.STACK_SUPPLY.v3.GENESIS_SUPPLY',
    cost: 'a v3 build measures sales against the wrong supply' },
  { sol: 'SALE_SUPPLY', file: V3_CURVE, ts: STACK_SUPPLY.v3.SALE_SUPPLY, where: 'v2/config.STACK_SUPPLY.v3.SALE_SUPPLY',
    cost: 'a v3 build prices against a curve that sells a different supply' },
  { sol: 'TIER_COUNT', file: V3_HOOK, ts: BigInt(STACK_SUPPLY.v3.TIER_COUNT), where: 'v2/config.STACK_SUPPLY.v3.TIER_COUNT',
    cost: 'a v3 build numbers the shelves out of the wrong total' },
  { sol: 'FUND_BPS', file: V3_HOOK, ts: V2.FUND_BPS, where: 'v2/config.V2.FUND_BPS',
    cost: 'a v3 build misstates the share routed to the project fund' },
  { sol: 'ADMIN_LAUNCH_WINDOW', file: V3_HOOK, ts: BigInt(V2.ADMIN_LAUNCH_WINDOW_S), where: 'v2/config.V2.ADMIN_LAUNCH_WINDOW_S',
    cost: 'a v3 launch panel opens launching to the public early' },
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

if (problems.length > 0) {
  console.error('\n[checkContractConstants] FAILED — the frontend no longer mirrors the contracts:\n')
  for (const p of problems) console.error('  • ' + p + '\n')
  process.exit(1)
}

console.log(`[checkContractConstants] OK — ${FIELDS.length} constants match src/*.sol`)
