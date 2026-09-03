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

/** Sum the per-chain gas spend (ETH, float). */
export function totalGasEth(data: ChainGasData[] = MOCK_CHAIN_GAS): number {
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
