// ─────────────────────────────────────────────────────────────────────────────
// Tosh — Shared PoG quota module
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth used by BOTH:
//   • soat-frontend/src/app/api/sign-allocation/route.ts  (Next.js API — viem)
//   • scripts/pogSigner.ts                                (Node.js script — ethers)
//
// The live exchange rate is NOT here — it is rotatable, so it lives in
// `app/lib/gasToSatoRate.ts`. This file holds the constants and the arithmetic.
//
// Keep this file dependency-free (no `viem`, `ethers`, or runtime-specific
// imports) so it can be consumed from either environment.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Contract-aligned constants ──────────────────────────────────────────────

/** Maximum ETH that can be allocated via a single PoG attestation.
 *  Mirrors `ToshFactory.maxPogAllocationLimit` (default 0.1 ether).
 *
 *  ⚠️ ON-CHAIN LOCKSTEP REQUIREMENT
 *  A signature whose `maxAlloc` exceeds the live on-chain dial reverts
 *  `registerPoG` with `ExceedsGlobalPogLimit`.  Keep this constant ≤ the
 *  factory dial. */
export const MAX_ALLOC_ETH_WEI: bigint = 10n ** 17n  // 0.1 ether

/** @deprecated v4.x alias — PoG quota is ETH-native in v5.0. */
export const MAX_ALLOC_SATO_WEI = MAX_ALLOC_ETH_WEI

/** Validity window for PoG signatures (seconds).
 *  Must be ≤ `ToshFactory.MAX_SIG_VALIDITY` (= 24 hours). */
export const SIG_VALIDITY_SECONDS = 24 * 60 * 60

// ─── Eligibility band (PM-F9) ────────────────────────────────────────────────

/**
 * Minimum lifetime gas spend, summed across `GAS_SCAN_CHAINS`, that earns any
 * allocation at all. Below this the oracle refuses to sign rather than signing
 * a small number.
 *
 * A floor is what makes the scan mean anything. Without one, the cost of a
 * second claim is one fresh address, so headcount rations supply and a wallet
 * created this morning ranks with one that has paid fees for three years. With
 * one, a claim costs what the floor costs, and that price is paid in public on
 * a chain nobody here controls.
 *
 * At `DEFAULT_GAS_TO_ETH_RATE` this floor corresponds to a 0.005 ETH
 * allocation — the smallest award the system will ever issue.
 */
export const POG_GAS_FLOOR_WEI: bigint = 5n * 10n ** 16n // 0.05 ETH

/**
 * Gas spend beyond which extra history stops counting.
 *
 * Set so that `POG_GAS_CAP_WEI * DEFAULT_GAS_TO_ETH_RATE` lands exactly on
 * `MAX_ALLOC_ETH_WEI`, which in turn equals the on-chain
 * `ToshFactory.maxPogAllocationLimit` default. Those three numbers are one
 * decision written in three places, and the on-chain one is load-bearing twice
 * over: it caps an attestation (`ExceedsGlobalPogLimit`), and `createLaunch`
 * freezes it into every new hook as that project's `perWalletCap`. Raising this
 * cap therefore cannot be done here alone — it needs an owner transaction
 * before the first launch exists, or launches created earlier keep a
 * per-wallet cap below the quota their depositors were promised.
 *
 * `assertPogBandCoherent()` below refuses to let the three drift.
 */
export const POG_GAS_CAP_WEI: bigint = 10n ** 18n // 1 ETH

/** STARTING exchange rate for the Proof-of-Gas oracle.
 *  1 ETH of historical multi-chain gas spend = 0.1 ETH of genesis allocation
 *  (fills the on-chain default ceiling).
 *
 *  Not the value to sign with: the admin endpoint rotates the live rate via
 *  owner-signed updates, so a signer must call `getGasToSatoRate()` from
 *  `app/lib/gasToSatoRate.ts`.  This constant is that store's seed and its
 *  fallback when the shared store is unreachable. */
export const DEFAULT_GAS_TO_ETH_RATE = 0.1

/** @deprecated v4.x alias of DEFAULT_GAS_TO_ETH_RATE. */
export const DEFAULT_GAS_TO_SATO_RATE = DEFAULT_GAS_TO_ETH_RATE

// ─── Multi-chain gas scan (stub) ─────────────────────────────────────────────

export interface ChainGasData {
  /** Chain display label (e.g. "Ethereum", "Base"). */
  chain: string
  /** Total historical gas spend on this chain, expressed in ETH. */
  ethGasUsed: number
}

/** Canonical mock gas-history dataset.
 *  Replace with a real indexer / RPC call in production.
 *  The same numbers feed BOTH the Next API and the standalone script.
 *
 *  Equal gas data is necessary but not sufficient for the two signers to agree
 *  on `maxAlloc` — they must also read the same exchange rate.  See
 *  `app/lib/gasToSatoRate.ts`; this comment used to promise lockstep on the
 *  strength of the table alone, while the rate silently diverged. */
/** FIXTURE ONLY. No production path reads this any more: `gasHistory.ts` scans
 *  five chains for real (PM-F9). It survives because scripts and tests want a
 *  stable table to assert against — if you find yourself reaching for it from
 *  `src/app/api/`, that is the bug. */
export const MOCK_CHAIN_GAS: ChainGasData[] = [
  { chain: 'Ethereum', ethGasUsed: 0.015 },
  { chain: 'Arbitrum', ethGasUsed: 0.008 },
  { chain: 'Optimism', ethGasUsed: 0.006 },
  { chain: 'Base',     ethGasUsed: 0.004 },
]

/** Per-chain weighting used when breaking `maxAlloc` down for UI display.
 *  Weights must sum to ≤ 1.0; remainder is treated as untracked. */
export const CHAIN_DISPLAY_WEIGHTS: Record<string, number> = {
  ETH_MAINNET: 0.50,
  BASE_L2:     0.25,
  ARB_ONE:     0.15,
  OP_MAINNET:  0.10,
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Sum the per-chain gas spend (ETH, float).
 *
 *  No default argument, deliberately. This defaulted to `MOCK_CHAIN_GAS`, which
 *  meant a caller who simply forgot to pass a scan result got the fixture and no
 *  warning of any kind — the exact failure PM-F9 was opened about, still armed
 *  after the mock stopped being wired in. Omitting the argument is now a
 *  compile error. */
export function totalGasEth(data: ChainGasData[]): number {
  return data.reduce((acc, d) => acc + d.ethGasUsed, 0)
}

/**
 * Compute the raw PoG quota in ETH-wei from gas history + exchange rate.
 *
 *   rawAlloc = floor(totalGasEth * gasToQuotaRate * 1e18)
 *   maxAlloc = min(rawAlloc, MAX_ALLOC_ETH_WEI)
 *
 * The contract additionally enforces a HARD revert via the live
 * `maxPogAllocationLimit` dial — no silent clamp on-chain.  Keep this
 * constant ≤ the on-chain ceiling or registrations revert with
 * `ExceedsGlobalPogLimit`.
 */
export function computeMaxAllocWei(
  gasEth: number,
  gasToQuotaRate: number,
): bigint {
  if (!Number.isFinite(gasEth) || gasEth < 0)            return 0n
  if (!Number.isFinite(gasToQuotaRate) || gasToQuotaRate <= 0) return 0n

  const rawWei = BigInt(Math.floor(gasEth * gasToQuotaRate * 1e18))
  return rawWei > MAX_ALLOC_ETH_WEI ? MAX_ALLOC_ETH_WEI : rawWei
}

/** Scale the float rate is converted to before integer arithmetic.
 *  1e9 keeps nine decimal places of a rate an owner can set, which is far more
 *  resolution than the dial has ever been moved by, and keeps the products
 *  below 2^53 nowhere — they are all BigInt. */
const RATE_SCALE = 1_000_000_000n

/**
 * The allocation for an exact gas spend, in wei, with no floating point in the
 * path that decides what gets signed.
 *
 *   floor  ->  0n, meaning "not eligible", distinct from "eligible for nothing"
 *              only in that the caller must not sign it
 *   band   ->  gasWei * rate, truncated
 *   cap    ->  MAX_ALLOC_ETH_WEI
 *
 * WHY THIS EXISTS ALONGSIDE `computeMaxAllocWei`
 *
 * That function takes ETH as a float, which was fine while its input was a
 * constant table of four short decimals. A real scan returns wei — up to
 * ~1e18 — and `Number(1e18 wei)/1e18` then back through `Math.floor(x * rate *
 * 1e18)` loses precision in the middle of the only number the signature is
 * about. Worse, it loses it *differently* depending on how the caller rounded
 * on the way in, and there are two callers: this repo's API route and
 * `scripts/pogSigner.ts`. Two signers that disagree by one wei produce two
 * different digests, and `registerPoG` accepts exactly one of them.
 *
 * `gasToSatoRate.ts` documents the last time those two drifted apart. This is
 * the same hazard one layer down, so the rate is scaled to an integer once and
 * every subsequent step is exact.
 */
export function computeMaxAllocFromWei(
  gasWei: bigint,
  gasToQuotaRate: number,
): bigint {
  if (gasWei < POG_GAS_FLOOR_WEI) return 0n
  if (!Number.isFinite(gasToQuotaRate) || gasToQuotaRate <= 0) return 0n

  const capped = gasWei > POG_GAS_CAP_WEI ? POG_GAS_CAP_WEI : gasWei
  const rate = BigInt(Math.round(gasToQuotaRate * Number(RATE_SCALE)))
  if (rate <= 0n) return 0n

  const alloc = (capped * rate) / RATE_SCALE
  return alloc > MAX_ALLOC_ETH_WEI ? MAX_ALLOC_ETH_WEI : alloc
}

/** True when `gasWei` clears the floor. Separate from the allocation so a
 *  caller can tell "below the floor" from "rate misconfigured", which both
 *  produce 0n above and mean entirely different things to a user. */
export function isPogEligible(gasWei: bigint): boolean {
  return gasWei >= POG_GAS_FLOOR_WEI
}

/**
 * Guards the one relationship that spans this file, the frontend cap, and a
 * contract we do not deploy from here.
 *
 * The band is only coherent if the cap maps onto the allocation ceiling at the
 * seeded rate. If someone raises `POG_GAS_CAP_WEI` and forgets
 * `MAX_ALLOC_ETH_WEI`, the extra history is silently discarded and the docs
 * describing the cap become false. If they raise both and forget the on-chain
 * dial, nothing is silent at all: every `registerPoG` reverts
 * `ExceedsGlobalPogLimit`, and it reverts for everyone at once.
 *
 * Throws rather than warns, and is called at module load, because a
 * misconfigured band should stop a deployment rather than issue signatures
 * nobody can redeem.
 */
export function assertPogBandCoherent(): void {
  if (POG_GAS_FLOOR_WEI <= 0n) {
    throw new Error('POG_GAS_FLOOR_WEI must be positive; a zero floor is PM-F9 reopened')
  }
  if (POG_GAS_CAP_WEI <= POG_GAS_FLOOR_WEI) {
    throw new Error(
      `POG_GAS_CAP_WEI (${POG_GAS_CAP_WEI}) must exceed POG_GAS_FLOOR_WEI (${POG_GAS_FLOOR_WEI})`)
  }
  const atCap = computeMaxAllocFromWei(POG_GAS_CAP_WEI, DEFAULT_GAS_TO_ETH_RATE)
  if (atCap !== MAX_ALLOC_ETH_WEI) {
    throw new Error(
      `PoG band incoherent: ${POG_GAS_CAP_WEI} wei of gas at the seeded rate `
      + `${DEFAULT_GAS_TO_ETH_RATE} yields ${atCap} wei, but MAX_ALLOC_ETH_WEI is `
      + `${MAX_ALLOC_ETH_WEI}. Cap, ceiling and ToshFactory.maxPogAllocationLimit `
      + 'are one decision in three places — see docs/PRE_MAINNET_CHECKLIST.md §6.4.')
  }
}

assertPogBandCoherent()

/**
 * Produce the deadline timestamp (Unix seconds) for a fresh signature.
 * `nowSec` is injected for deterministic tests.
 */
export function computeDeadline(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return nowSec + SIG_VALIDITY_SECONDS
}

// `breakdownByChain` used to live here: it split a `maxAlloc` across
// `CHAIN_DISPLAY_WEIGHTS` for the UI, after first dividing by 5 under a
// "mirrors legacy display math" comment that explained nothing and matched no
// other number in the codebase. Nothing called it, so the wrong figure was
// never rendered — deleted rather than kept as a latent one-fifth error
// waiting for its first caller. `CHAIN_DISPLAY_WEIGHTS` above is what a
// replacement would need; a correct version is `maxAllocWei / 1e18 * weight`.

// ─── Admin-config fetch (optional) ───────────────────────────────────────────

/**
 * Fetch the current gas-to-ETH quota rate from the admin config endpoint.
 *
 * For the offline CLI signer. Code running INSIDE the Next server must call
 * `getGasToSatoRate()` from `app/lib/gasToSatoRate.ts` instead — it reads the
 * same value without an HTTP hop through its own process.
 *
 * @param baseUrl   Base URL of the Next.js server (e.g. `http://localhost:3000`).
 *                  Pass `''` (default) to skip the network call and use the
 *                  hard-coded default. Note what that means: with no base URL
 *                  this returns the SEED rate, not the live one, so a caller
 *                  that omits it will diverge from every signer that does not.
 */
export async function fetchGasToSatoRate(baseUrl: string = ''): Promise<number> {
  if (!baseUrl) return DEFAULT_GAS_TO_ETH_RATE
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/config`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { globalGasToSatoRate?: number }
    return typeof data.globalGasToSatoRate === 'number' && data.globalGasToSatoRate > 0
      ? data.globalGasToSatoRate
      : DEFAULT_GAS_TO_ETH_RATE
  } catch {
    return DEFAULT_GAS_TO_ETH_RATE
  }
}
