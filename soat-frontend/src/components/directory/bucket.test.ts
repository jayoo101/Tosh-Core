import { describe, expect, it, vi } from 'vitest'

// `useDirectoryProjects` pulls addresses from `contracts.ts`, which throws at
// import without a factory address. Hoisting beats the static import below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { bucket } from './useDirectoryProjects'

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
