import { describe, expect, it, vi } from 'vitest'

// `useDirectoryProjects` pulls addresses from `contracts.ts`, which throws at
// import without a factory address. Hoisting beats the static import below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { bucket, deriveGenesisDuration } from './useDirectoryProjects'
import { GENESIS_DURATIONS } from '@/lib/contracts'

/**
 * The tab rule, pinned because it has now been wrong twice in the same place.
 *
 * It first bucketed on the soft cap, which decides nothing. It then bucketed
 * `archived` off `genesisDeadline + LAUNCH_WINDOW`, which was correct only
 * while the 7-day window was the single way into a refund. A raise too small
 * to carry a ladder now refunds the moment genesis closes, so that rule filed
 * a refundable project under "awaiting launch" for a week — a countdown to a
 * launch that could never happen, drawn over a refund already available.
 *
 * `canRefund()` is the contract's own answer and folds in both doors, so the
 * cases below are about trusting it rather than about re-deriving it. There is
 * deliberately no test here for "seven days have passed": this function no
 * longer knows what a week is, which is the point of the change.
 */

const DEADLINE = 1_000_000n
const AFTER = Number(DEADLINE) + 1
const DURING = Number(DEADLINE) - 1

describe('bucket', () => {
  it('files a launched project as completed whatever else is true', () => {
    expect(bucket(true, false, DEADLINE, AFTER)).toBe('completed')
    expect(bucket(true, true, DEADLINE, AFTER)).toBe('completed')
  })

  it('is live while deposits are open, even for a raise that can never launch', () => {
    // `canRefund()` is false here anyway, but the clock is what decides: a
    // round still taking deposits has not failed at anything yet.
    expect(bucket(false, false, DEADLINE, DURING)).toBe('live')
  })

  it('archives as soon as the hook says refunds are open', () => {
    // The case the old clock rule got wrong: one second past the deadline,
    // six days and 23 hours still on the launch window, and the raise is
    // already refundable because it cannot carry a ladder.
    expect(bucket(false, true, DEADLINE, AFTER)).toBe('archived')
  })

  it('leaves a raise that could still launch under awaiting-launch', () => {
    expect(bucket(false, false, DEADLINE, AFTER)).toBe('launching')
  })

  it('treats an unsynced clock as live rather than as expired', () => {
    expect(bucket(false, false, DEADLINE, 0)).toBe('live')
  })

  it('understates rather than invents a refund when the read failed', () => {
    // A failed `canRefund` read arrives here as `false`. That must land on
    // `launching`, not `archived`: a card advertising a refund the hook would
    // reject sends the depositor to a button that reverts.
    expect(bucket(false, false, DEADLINE, AFTER)).not.toBe('archived')
  })
})

/**
 * The countdown bar's denominator, which is DERIVED rather than read.
 *
 * `genesisDuration()` is the authority; this reconstructs it from two values the
 * directory already holds, to avoid re-fetching a deployment-frozen constant 48
 * times every 20 s. The identity holds because `initializeToken` sets
 * `genesisDeadline = block.timestamp + duration` and the factory pushes
 * `LaunchInfo(..., block.timestamp)` later in the same `createLaunch` call.
 *
 * That is an invariant across two contracts, so what is pinned here is the
 * SAFETY VALVE rather than the happy path: the hook accepts only three
 * durations, so a span that is not one of them cannot be a real duration, and
 * the answer has to be `0n` — which `genesisWindow` draws as nothing. A silently
 * skewed denominator would render a bar measuring the window against a number no
 * contract agrees with, and a wrong bar is worse than no bar.
 */
describe('deriveGenesisDuration', () => {
  const created = 1_700_000_000n

  it('recovers each of the three legal windows exactly', () => {
    for (const rung of Object.values(GENESIS_DURATIONS)) {
      expect(deriveGenesisDuration(created + rung, created)).toBe(rung)
    }
  })

  it('refuses a span that is not one of the three rungs', () => {
    // What a broken same-transaction assumption would look like: plausible
    // magnitude, not a duration the hook would have accepted.
    expect(deriveGenesisDuration(created + 3n * 60n * 60n + 12n, created)).toBe(0n)
    expect(deriveGenesisDuration(created + 48n * 60n * 60n, created)).toBe(0n)
  })

  it('refuses a deadline that is not after creation', () => {
    // Both reads default to 0n on failure, and 0n - 0n is a legal subtraction
    // that would otherwise hand the bar a zero window.
    expect(deriveGenesisDuration(0n, 0n)).toBe(0n)
    expect(deriveGenesisDuration(created, created)).toBe(0n)
    expect(deriveGenesisDuration(created - 1n, created)).toBe(0n)
  })

  it('refuses a zero deadline against a real creation time', () => {
    // The shape a failed `genesisDeadline` read actually takes: the row still
    // carries a true `createdAt` from the factory.
    expect(deriveGenesisDuration(0n, created)).toBe(0n)
  })
})
