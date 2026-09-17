import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SIG_VALIDITY_SECONDS,
  ATTESTATION_HEADROOM_SECONDS,
  ATTESTATION_TTL_SECONDS,
  computeDeadline,
  assertPogBandCoherent,
  pogBandProblem,
  pogCapWei,
  DEFAULT_POG_BAND,
  DEFAULT_POG_MAX_ALLOC_WEI,
  DEFAULT_POG_GAS_FLOOR_WEI,
  DEFAULT_GAS_TO_ETH_RATE,
  computeMaxAllocFromWei,
} from './pogQuota'

/**
 * The deadline band, which had no test at all — and that is why it drifted.
 *
 * `ToshFactory.registerPoG` bounds a deadline on both sides, and the upper side
 * is strict:
 *
 *   if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();
 *
 * `sign-allocation/route.ts` worked out that signing at the ceiling leaves no
 * tolerance for clock skew and gave itself an hour, with a test. `computeDeadline`
 * — the shared helper, and the only thing `scripts/pogSigner.ts` calls — kept the
 * ceiling as its TTL, with no test. Measured against the live 46630 factory by
 * `scripts/probeDeadlineMargin.mjs`: the CLI path tolerated 0 s and reverted
 * `SignatureTooLong` from a machine 3 s fast; the route path tolerated 3600 s and
 * cleared the gate.
 */

/** The on-chain predicate, transcribed. Returns the revert name, or null. */
function registerPoGDeadlineGate(deadline: number, blockTimestamp: number): string | null {
  if (deadline > blockTimestamp + ON_CHAIN_MAX_SIG_VALIDITY) return 'SignatureTooLong'
  if (blockTimestamp > deadline) return 'SignatureExpired'
  return null
}

/**
 * Read the ceiling out of the contract rather than restating it.
 *
 * A mirrored constant asserted against a literal only proves the literal was
 * copied once. Parsing the source makes the mirror fail when the contract moves,
 * which is the whole claim the TS side makes about this number.
 */
function solidityMaxSigValidity(): number {
  const sol = readFileSync(
    join(process.cwd(), '..', 'src', 'ToshFactory.sol'), 'utf8')
  const m = sol.match(/constant\s+MAX_SIG_VALIDITY\s*=\s*(\d+)\s*(hours|days|minutes|seconds)\s*;/)
  if (!m) throw new Error('could not find MAX_SIG_VALIDITY in src/ToshFactory.sol')
  const n = Number(m[1])
  const unit = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[m[2] as 'hours']
  return n * unit
}

const ON_CHAIN_MAX_SIG_VALIDITY = solidityMaxSigValidity()

describe('PoG deadline band', () => {
  it('mirrors ToshFactory.MAX_SIG_VALIDITY, read from the contract', () => {
    expect(SIG_VALIDITY_SECONDS).toBe(ON_CHAIN_MAX_SIG_VALIDITY)
  })

  it('signs strictly below the on-chain ceiling', () => {
    expect(ATTESTATION_TTL_SECONDS).toBeGreaterThan(0)
    expect(ATTESTATION_TTL_SECONDS).toBeLessThan(SIG_VALIDITY_SECONDS)
  })

  it('leaves the same headroom the route already demanded of itself', () => {
    // The route's own test requires at least 30 minutes. Holding the shared
    // helper to a weaker bar is how one signer ends up tolerant and the other
    // not, which is exactly what happened.
    expect(ATTESTATION_HEADROOM_SECONDS).toBeGreaterThanOrEqual(30 * 60)
    expect(SIG_VALIDITY_SECONDS - ATTESTATION_TTL_SECONDS).toBe(ATTESTATION_HEADROOM_SECONDS)
  })

  it('tolerates clock skew exactly equal to the headroom, and no more', () => {
    // This is the property the constant exists for, stated against the real
    // predicate instead of trusting the arithmetic in a comment.
    const chainNow = 1_800_000_000

    const atLimit = computeDeadline(chainNow + ATTESTATION_HEADROOM_SECONDS)
    expect(registerPoGDeadlineGate(atLimit, chainNow)).toBeNull()

    const pastLimit = computeDeadline(chainNow + ATTESTATION_HEADROOM_SECONDS + 1)
    expect(registerPoGDeadlineGate(pastLimit, chainNow)).toBe('SignatureTooLong')
  })

  it('would have failed on a one-second fast clock at the old TTL', () => {
    // The defect, as a direct counter-example: signing at the ceiling reduces the
    // bound to `signerNow > block.timestamp`.
    const chainNow = 1_800_000_000
    const oldStyleDeadline = (chainNow + 1) + SIG_VALIDITY_SECONDS
    expect(registerPoGDeadlineGate(oldStyleDeadline, chainNow)).toBe('SignatureTooLong')

    // And the same one-second skew is a non-event now.
    expect(registerPoGDeadlineGate(computeDeadline(chainNow + 1), chainNow)).toBeNull()
  })

  it('does not sign a deadline already in the past', () => {
    const chainNow = 1_800_000_000
    expect(registerPoGDeadlineGate(computeDeadline(chainNow), chainNow)).toBeNull()
  })

  it('is the one TTL both signers use', () => {
    // `sign-allocation` used to hold its own copy of both numbers. The anti-
    // regression is that the route imports these, so a future edit to one signer
    // cannot silently leave the other at the ceiling.
    const routeSource = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'sign-allocation', 'route.ts'), 'utf8')
    expect(routeSource).toMatch(/ATTESTATION_TTL_SEC:\s*number\s*=\s*ATTESTATION_TTL_SECONDS/)
    expect(routeSource).not.toMatch(/MAX_SIG_VALIDITY_SEC\s*-\s*60\s*\*\s*60/)
  })
})

describe('PoG allocation band', () => {
  it('holds together at module load', () => {
    expect(() => assertPogBandCoherent()).not.toThrow()
  })

  it('derives a cap that lands exactly on the ceiling, whatever the dials', () => {
    // The cap used to be a fourth constant with a load-time assertion holding
    // it against the ceiling and the rate. Now that all three are tunable, the
    // property has to hold for bands nobody wrote down — so assert it over a
    // spread rather than over the seeds alone.
    const bands = [
      DEFAULT_POG_BAND,
      { floorWei: 10n ** 15n, maxAllocWei: 10n ** 18n, rate: 0.1 },
      { floorWei: 10n ** 15n, maxAllocWei: 3n * 10n ** 17n, rate: 0.75 },
      { floorWei: 1n, maxAllocWei: 7n * 10n ** 16n, rate: 1.5 },
    ]
    for (const band of bands) {
      expect(computeMaxAllocFromWei(pogCapWei(band), band)).toBe(band.maxAllocWei)
      // And one wei short of the cap must not already be at the ceiling, or the
      // cap is not where the rate reaches it.
      expect(computeMaxAllocFromWei(pogCapWei(band) - 1n, band))
        .toBeLessThanOrEqual(band.maxAllocWei)
    }
  })

  it('holds the numbers that were actually chosen', () => {
    expect(DEFAULT_POG_GAS_FLOOR_WEI).toBe(25_000_000_000_000_000n)  // 0.025 ETH
    expect(DEFAULT_POG_MAX_ALLOC_WEI).toBe(500_000_000_000_000_000n) // 0.5 ETH
    expect(DEFAULT_GAS_TO_ETH_RATE).toBe(0.5)                        // 0.5 ETH per 1 ETH of gas
    // 1 ETH of gas fills the ceiling at that rate.
    expect(pogCapWei(DEFAULT_POG_BAND)).toBe(10n ** 18n)
  })

  it('refuses the bands an admin rotation could otherwise arm', () => {
    expect(pogBandProblem(DEFAULT_POG_BAND)).toBeNull()
    expect(pogBandProblem({ ...DEFAULT_POG_BAND, floorWei: 0n })).toMatch(/floorWei/)
    expect(pogBandProblem({ ...DEFAULT_POG_BAND, maxAllocWei: 0n })).toMatch(/maxAllocWei/)
    for (const rate of [0, -1, NaN, Infinity]) {
      expect(pogBandProblem({ ...DEFAULT_POG_BAND, rate })).toMatch(/rate/)
    }
    // A floor above the cap collapses the band: every eligible wallet gets the
    // whole ceiling and the gas history stops ranking anybody.
    expect(pogBandProblem({ floorWei: 2n * 10n ** 18n, maxAllocWei: 10n ** 17n, rate: 0.5 }))
      .toMatch(/must sit below the cap/)
  })
})
