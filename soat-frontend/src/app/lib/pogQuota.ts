// ─────────────────────────────────────────────────────────────────────────────
// Tosh — Shared PoG quota module
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth used by BOTH:
//   • soat-frontend/src/app/api/sign-allocation/route.ts  (Next.js API — viem)
//   • scripts/pogSigner.ts                                (Node.js script — ethers)
//
// NONE OF THE THREE BAND VALUES LIVE HERE AS THE LIVE ONES. The floor, the
// allocation ceiling and the exchange rate are all owner-tunable at runtime and
// are held in `app/lib/pogParams.ts`; this file holds their SEEDS and the
// arithmetic, and every function that decides an allocation takes the band as an
// argument rather than reading a constant. A tunable read from a module constant
// is a dial that reports success and changes nothing — see that module's header
// for the two-week outage that shape produced when only the rate was tunable.
//
// Keep this file dependency-free (no `viem`, `ethers`, or runtime-specific
// imports) so it can be consumed from either environment.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Contract-aligned constants ──────────────────────────────────────────────

/** Seed for the maximum ETH one PoG attestation may allocate.
 *
 *  Also the per-wallet deposit ceiling, because `createLaunch` freezes
 *  `ToshFactory.maxPogAllocationLimit` into every new hook as its
 *  `perWalletCap`. So this number answers "how much may one wallet put in".
 *
 *  ⚠️ ON-CHAIN LOCKSTEP REQUIREMENT
 *  A signature whose `maxAlloc` exceeds the live on-chain dial reverts
 *  `registerPoG` with `ExceedsGlobalPogLimit`. The admin endpoint refuses a
 *  ceiling above the live dial for that reason; raising both is two
 *  transactions, and the on-chain one goes first. */
export const DEFAULT_POG_MAX_ALLOC_WEI: bigint = 5n * 10n ** 17n  // 0.5 ether

/** The on-chain ceiling on how far ahead a deadline may sit.
 *  Mirrors `ToshFactory.MAX_SIG_VALIDITY` (= 24 hours). Not a TTL to sign with —
 *  see `ATTESTATION_TTL_SECONDS`, which is. */
export const SIG_VALIDITY_SECONDS = 24 * 60 * 60

/**
 * Headroom every signer must leave under `SIG_VALIDITY_SECONDS`.
 *
 * The on-chain bound is two-sided and the upper side is strict:
 *
 *   `if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();`
 *
 * Signing `deadline = signerNow + T` makes that fail exactly when
 * `signerNow - block.timestamp > MAX_SIG_VALIDITY - T`. So the headroom a signer
 * leaves IS the clock skew it tolerates, and a TTL equal to the ceiling tolerates
 * none: one second of fast clock, or a sequencer whose timestamps lag wall time,
 * and every attestation reverts — totally, for as long as the skew lasts, under
 * an error name that points at the signature's length rather than at a clock.
 *
 * An hour costs nothing. The window is sized for human-paced wallet flows, where
 * 23 h and 24 h are the same number.
 *
 * This lives here, rather than in whichever route needs it, because it did not:
 * `sign-allocation` worked this out and applied it locally while
 * `computeDeadline()` — the shared helper, and the one `scripts/pogSigner.ts`
 * calls — kept the ceiling as its TTL. Measured against the live 46630 factory
 * with `scripts/probeDeadlineMargin.mjs`: the CLI path tolerated 0 s and reverted
 * `SignatureTooLong` on a machine 3 s fast, while the route path tolerated 3600 s
 * and cleared the gate. Same pair of signers, same class of divergence as the
 * exchange rate in `pogParams.ts`.
 */
export const ATTESTATION_HEADROOM_SECONDS = 60 * 60

/** The TTL a signer actually uses. One decision, both signers. */
export const ATTESTATION_TTL_SECONDS =
  SIG_VALIDITY_SECONDS - ATTESTATION_HEADROOM_SECONDS

// ─── Eligibility band (PM-F9) ────────────────────────────────────────────────

/**
 * Seed for the minimum lifetime gas spend, summed across `GAS_SCAN_CHAINS`,
 * that earns any allocation at all. Below the floor the oracle refuses to sign
 * rather than signing a small number.
 *
 * A floor is what makes the scan mean anything. Without one, the cost of a
 * second claim is one fresh address, so headcount rations supply and a wallet
 * created this morning ranks with one that has paid fees for three years. With
 * one, a claim costs what the floor costs, and that price is paid in public on
 * a chain nobody here controls.
 *
 * At `DEFAULT_GAS_TO_ETH_RATE` this floor corresponds to a 0.0125 ETH
 * allocation — the smallest award the seeded band will issue.
 */
export const DEFAULT_POG_GAS_FLOOR_WEI: bigint = 25n * 10n ** 15n // 0.025 ETH

/** STARTING exchange rate for the Proof-of-Gas oracle.
 *  1 ETH of historical multi-chain gas spend = 0.5 ETH of genesis allocation,
 *  which fills the seeded ceiling at exactly 1 ETH of gas.
 *
 *  Not the value to sign with: the admin endpoint rotates the live band via
 *  owner-signed updates, so a signer must call `getPogBand()` from
 *  `app/lib/pogParams.ts`.  This constant is that store's seed and its
 *  fallback when the shared store is unreachable. */
export const DEFAULT_GAS_TO_ETH_RATE = 0.5

/** @deprecated v4.x alias of DEFAULT_GAS_TO_ETH_RATE. */
export const DEFAULT_GAS_TO_SATO_RATE = DEFAULT_GAS_TO_ETH_RATE

/**
 * The three numbers that decide an allocation, carried together.
 *
 * Together and not separately, because they are one decision: an allocation is
 * `min(gas, cap) * rate` clamped to `maxAllocWei`, and the cap is derived from
 * the other two (see `pogCapWei`). Passing them as a unit is what stops a
 * caller from reading a rotated rate against a stale ceiling — the class of
 * mismatch that produces two signers, two digests and one redeemable
 * attestation.
 */
export interface PogBand {
  /** Lifetime gas, in wei, required to qualify at all. */
  floorWei: bigint
  /** Ceiling on one attestation, in wei. Also the per-wallet deposit cap. */
  maxAllocWei: bigint
  /** ETH of deposit quota earned per 1 ETH of historical gas. */
  rate: number
}

/** The band a fresh deployment starts from, and the fallback when the shared
 *  store cannot be read. */
export const DEFAULT_POG_BAND: PogBand = {
  floorWei: DEFAULT_POG_GAS_FLOOR_WEI,
  maxAllocWei: DEFAULT_POG_MAX_ALLOC_WEI,
  rate: DEFAULT_GAS_TO_ETH_RATE,
}

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
 *  on `maxAlloc` — they must also read the same band.  See
 *  `app/lib/pogParams.ts`; this comment used to promise lockstep on the
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

// `computeMaxAllocWei(gasEth: number, rate)` used to sit here: the same
// arithmetic with ETH as a float on the way in. Nothing called it once the scan
// started returning wei, and a float path cannot be made band-aware without
// reintroducing the rounding divergence `computeMaxAllocFromWei` exists to rule
// out, so it was deleted rather than updated.

/** Scale the float rate is converted to before integer arithmetic.
 *  1e9 keeps nine decimal places of a rate an owner can set, which is far more
 *  resolution than the dial has ever been moved by, and keeps the products
 *  below 2^53 nowhere — they are all BigInt. */
const RATE_SCALE = 1_000_000_000n

/** The rate as an exact integer, or 0n if it is not a usable rate. */
function scaledRate(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) return 0n
  const scaled = BigInt(Math.round(rate * Number(RATE_SCALE)))
  return scaled > 0n ? scaled : 0n
}

/**
 * Gas spend beyond which extra history stops counting, DERIVED from the
 * ceiling and the rate rather than stored beside them.
 *
 * It used to be its own constant, with a comment explaining that it, the
 * allocation ceiling and `ToshFactory.maxPogAllocationLimit` were "one decision
 * written in three places" and a load-time assertion to catch the day somebody
 * moved one of them. Making the ceiling and the rate tunable would have turned
 * that assertion into a runtime trap an owner could arm from the admin panel:
 * any rotation that did not also move the cap would silently discard history or
 * cap allocations below what the band promised.
 *
 * Deriving it removes the failure instead of guarding it. The cap is exactly
 * the gas at which the rate first reaches the ceiling, rounded up so the wallet
 * sitting on the boundary is not short-changed by integer division, and the
 * scan uses it only to stop paging once more requests cannot change the answer.
 */
export function pogCapWei(band: PogBand): bigint {
  const rate = scaledRate(band.rate)
  if (rate <= 0n) return band.maxAllocWei
  return (band.maxAllocWei * RATE_SCALE + rate - 1n) / rate
}

/**
 * The allocation for an exact gas spend, in wei, with no floating point in the
 * path that decides what gets signed.
 *
 *   below floor  ->  0n, meaning "not eligible", distinct from "eligible for
 *                    nothing" only in that the caller must not sign it
 *   in band      ->  gasWei * rate, truncated
 *   at the cap   ->  band.maxAllocWei
 *
 * WHY THE ARITHMETIC IS INTEGER ALL THE WAY DOWN
 *
 * A real scan returns wei — up to ~1e18 — and `Number(wei)/1e18` then back
 * through `Math.floor(x * rate * 1e18)` loses precision in the middle of the
 * only number the signature is about. Worse, it loses it *differently*
 * depending on how the caller rounded on the way in, and there are two callers:
 * this repo's API route and `scripts/pogSigner.ts`. Two signers that disagree
 * by one wei produce two different digests, and `registerPoG` accepts exactly
 * one of them.
 *
 * `pogParams.ts` documents the last time those two drifted apart. This is the
 * same hazard one layer down, so the rate is scaled to an integer once and
 * every subsequent step is exact.
 */
export function computeMaxAllocFromWei(gasWei: bigint, band: PogBand): bigint {
  if (gasWei < band.floorWei) return 0n
  const rate = scaledRate(band.rate)
  if (rate <= 0n) return 0n

  const cap = pogCapWei(band)
  const capped = gasWei > cap ? cap : gasWei

  const alloc = (capped * rate) / RATE_SCALE
  return alloc > band.maxAllocWei ? band.maxAllocWei : alloc
}

/** True when `gasWei` clears the floor. Separate from the allocation so a
 *  caller can tell "below the floor" from "rate misconfigured", which both
 *  produce 0n above and mean entirely different things to a user. */
export function isPogEligible(gasWei: bigint, band: PogBand): boolean {
  return gasWei >= band.floorWei
}

/**
 * Why a band is unusable, in a sentence, or null when it is fine.
 *
 * Returns rather than throws because the admin endpoint needs to refuse a bad
 * rotation with an explanation an operator can act on, and `assertPogBandCoherent`
 * needs to stop a deployment. One set of rules, two failure styles.
 *
 * The cap/ceiling relationship that used to be checked here is now derived
 * (`pogCapWei`), so what is left are the bounds that no amount of derivation can
 * rescue. The on-chain half of the coupling — `maxAllocWei` must not exceed the
 * live `ToshFactory.maxPogAllocationLimit`, or every `registerPoG` reverts
 * `ExceedsGlobalPogLimit` for everyone at once — is checked in the admin route,
 * because it needs an RPC call and this module is deliberately dependency-free.
 */
export function pogBandProblem(band: PogBand): string | null {
  if (band.floorWei <= 0n) {
    return 'floorWei must be positive; a zero floor is PM-F9 reopened — one fresh '
      + 'address per claim, and headcount rations the supply'
  }
  if (band.maxAllocWei <= 0n) {
    return 'maxAllocWei must be positive; a zero ceiling allocates nothing to anybody'
  }
  if (scaledRate(band.rate) <= 0n) {
    return `rate must be a positive finite number with at most 9 decimals, got ${band.rate}`
  }
  const cap = pogCapWei(band)
  if (cap <= band.floorWei) {
    return `floorWei (${band.floorWei}) must sit below the cap (${cap} wei of gas, where `
      + `the rate ${band.rate} first reaches the ${band.maxAllocWei} wei ceiling). Above `
      + 'it, every eligible wallet gets the full ceiling and the gas history stops '
      + 'ranking anybody'
  }
  return null
}

/**
 * Stop a deployment whose seeded band, or whose deadline band, cannot work.
 *
 * Throws rather than warns, and is called at module load, because a
 * misconfigured band should stop a deployment rather than issue signatures
 * nobody can redeem.
 */
export function assertPogBandCoherent(band: PogBand = DEFAULT_POG_BAND): void {
  const problem = pogBandProblem(band)
  if (problem) throw new Error(`PoG band incoherent: ${problem}`)

  // The deadline band, checked here for the same reason the allocation band is:
  // it is a relationship between numbers that live apart, and it drifted once.
  if (ATTESTATION_HEADROOM_SECONDS <= 0) {
    throw new Error(
      'ATTESTATION_HEADROOM_SECONDS must be positive. At zero, a signer whose clock '
      + 'is one second fast makes every registration revert SignatureTooLong.')
  }
  if (ATTESTATION_TTL_SECONDS <= 0 || ATTESTATION_TTL_SECONDS >= SIG_VALIDITY_SECONDS) {
    throw new Error(
      `ATTESTATION_TTL_SECONDS (${ATTESTATION_TTL_SECONDS}) must sit strictly between 0 `
      + `and SIG_VALIDITY_SECONDS (${SIG_VALIDITY_SECONDS}), which mirrors the on-chain `
      + 'ToshFactory.MAX_SIG_VALIDITY ceiling.')
  }
}

assertPogBandCoherent()

/**
 * Produce the deadline timestamp (Unix seconds) for a fresh signature.
 * `nowSec` is injected for deterministic tests.
 *
 * Uses `ATTESTATION_TTL_SECONDS`, not `SIG_VALIDITY_SECONDS`. The latter is the
 * on-chain ceiling; signing right at it leaves no tolerance for clock skew in the
 * one direction that reverts. See `ATTESTATION_HEADROOM_SECONDS`.
 */
export function computeDeadline(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return nowSec + ATTESTATION_TTL_SECONDS
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
 * Fetch the live band from the admin config endpoint.
 *
 * For the offline CLI signer. Code running INSIDE the Next server must call
 * `getPogBand()` from `app/lib/pogParams.ts` instead — it reads the same values
 * without an HTTP hop through its own process.
 *
 * All three values are read, not just the rate. While only the rate was
 * tunable, a CLI that fetched it and a floor it held as a constant were still
 * in lockstep. With the floor and the ceiling tunable too, fetching one of
 * three is the divergence this endpoint exists to prevent, dressed as an
 * optimisation.
 *
 * @param baseUrl   Base URL of the Next.js server (e.g. `http://localhost:3000`).
 *                  Pass `''` (default) to skip the network call and use the
 *                  seeded band. Note what that means: with no base URL this
 *                  returns the SEEDS, not the live values, so a caller that
 *                  omits it will diverge from every signer that does not.
 */
export async function fetchPogBand(baseUrl: string = ''): Promise<PogBand> {
  if (!baseUrl) return DEFAULT_POG_BAND
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/config`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      globalGasToSatoRate?: number
      pogFloorWei?: string
      pogMaxAllocWei?: string
    }
    const band: PogBand = {
      rate: typeof data.globalGasToSatoRate === 'number' && data.globalGasToSatoRate > 0
        ? data.globalGasToSatoRate
        : DEFAULT_GAS_TO_ETH_RATE,
      floorWei: parseWeiOr(data.pogFloorWei, DEFAULT_POG_GAS_FLOOR_WEI),
      maxAllocWei: parseWeiOr(data.pogMaxAllocWei, DEFAULT_POG_MAX_ALLOC_WEI),
    }
    // A band the server would refuse is not one to sign against either: fall
    // back whole rather than mixing one live value into two seeded ones.
    return pogBandProblem(band) ? DEFAULT_POG_BAND : band
  } catch {
    return DEFAULT_POG_BAND
  }
}

function parseWeiOr(raw: unknown, fallback: bigint): bigint {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return fallback
  try {
    return BigInt(raw)
  } catch {
    return fallback
  }
}
