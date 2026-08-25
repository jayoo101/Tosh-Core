// ─────────────────────────────────────────────────────────────────────────────
// Tosh — Shared PoG quota module
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth used by BOTH:
//   • soat-frontend/src/app/api/pog/route.ts   (Next.js API — viem)
//   • scripts/pogSigner.ts                     (Node.js script — ethers)
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

/** Canonical exchange rate for the Proof-of-Gas oracle.
 *  1 ETH of historical multi-chain gas spend = 0.1 ETH of genesis allocation
 *  (fills the on-chain default ceiling).  The admin endpoint can rotate the
 *  live rate independently via owner-signed updates. */
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
 *  The same numbers feed BOTH the Next API and the standalone script,
 *  so the two stay in lockstep no matter which is called first. */
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

/**
 * Break a `maxAlloc` (ETH-wei) into per-chain display amounts (ETH).
 * Purely for UI; the on-chain signature only carries the aggregate maxAlloc.
 */
export function breakdownByChain(maxAllocWei: bigint): Record<string, string> {
  const totalEth = Number(maxAllocWei) / 1e18 / 5   // mirrors legacy display math
  const out: Record<string, string> = {}
  let runningTotal = 0
  for (const [chain, weight] of Object.entries(CHAIN_DISPLAY_WEIGHTS)) {
    const v = totalEth * weight
    out[chain] = v.toFixed(4)
    runningTotal += v
  }
  out.total = runningTotal.toFixed(4)
  return out
}

// ─── Admin-config fetch (optional) ───────────────────────────────────────────

/**
 * Fetch the current gas-to-ETH quota rate from the admin config endpoint.
 *
 * @param baseUrl   Base URL of the Next.js server (e.g. `http://localhost:3000`).
 *                  Pass `''` (default) to skip the network call and use the
 *                  hard-coded default — useful for Next API routes that already
 *                  know the rate in-process.
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
