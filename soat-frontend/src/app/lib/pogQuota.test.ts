import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SIG_VALIDITY_SECONDS,
  ATTESTATION_HEADROOM_SECONDS,
  ATTESTATION_TTL_SECONDS,
  computeDeadline,
  assertPogBandCoherent,
  MAX_ALLOC_ETH_WEI,
  POG_GAS_CAP_WEI,
  POG_GAS_FLOOR_WEI,
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

  it('puts the cap exactly on the allocation ceiling at the seeded rate', () => {
    expect(computeMaxAllocFromWei(POG_GAS_CAP_WEI, DEFAULT_GAS_TO_ETH_RATE))
      .toBe(MAX_ALLOC_ETH_WEI)
  })

  it('keeps the floor below the cap', () => {
    expect(POG_GAS_FLOOR_WEI).toBeGreaterThan(0n)
    expect(POG_GAS_CAP_WEI).toBeGreaterThan(POG_GAS_FLOOR_WEI)
  })
})
