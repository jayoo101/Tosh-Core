/**
 * scanJobStore.test.ts — the credit gauge, and why its expiry is the design.
 *
 * The Proof-of-Gas scan reads the Blockscout PRO API, whose tier is bounded by
 * credits per day (100,000, at roughly 20 a call) rather than by requests per
 * second. A request-count ceiling cannot bound that alone, because one scan costs
 * between 5 calls and 25 depending on whose wallet it is — a five-fold spread
 * decided by whoever shows up. So `/api/pog-scan` admits against the balance the
 * host itself reports, carried between requests by this gauge.
 *
 * The subtle part is not storing a number, it is that the number must go stale.
 * A reading is only ever a floor: within a day the balance falls, so an old value
 * is pessimistic — harmless during traffic, and an outage across the daily reset,
 * where yesterday's exhausted reading would refuse every claimant on a budget
 * that had just been refilled. Both directions of that are tested here, because
 * both are silent: the wrong one produces a working-looking service that declines
 * everyone.
 *
 * No Upstash variables are set under test, so this exercises the in-process
 * backend. That is the same code path a single-instance deployment uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { recordCreditBalance, readCreditBalance } from './scanJobStore'

/** The gauge's TTL, restated rather than exported: a test that reads the
 *  constant it is checking cannot notice the constant changing. */
const TTL_MS = 60 * 60 * 1000

/**
 * The in-process backend is module-level, and deliberately pinned to
 * `globalThis` so it survives a dev hot reload — which means it also survives
 * between tests in this file. Rather than adding a production-only reset hook for
 * the tests to call, each test starts a day further along the fake clock, so
 * anything a previous test wrote has already aged past the TTL and reads as
 * absent. That is the same mechanism under test, used honestly.
 */
let testDay = 0

beforeEach(() => {
  vi.useFakeTimers()
  testDay += 1
  vi.setSystemTime(new Date(Date.UTC(2026, 8, testDay, 12, 0, 0)))
})

afterEach(async () => {
  vi.useRealTimers()
})

describe('the PoG credit gauge', () => {
  it('carries a reading from one request to the next', async () => {
    await recordCreditBalance(45_000)
    await expect(readCreditBalance()).resolves.toBe(45_000)
  })

  it('reads null before anything has been recorded', async () => {
    // Distinct from zero, and the route depends on the distinction: unknown
    // admits, empty refuses. Collapsing them either refuses everyone on a cold
    // start or spends a budget that is already gone.
    await expect(readCreditBalance()).resolves.toBeNull()
  })

  it('keeps zero as a real reading rather than an absent one', async () => {
    await recordCreditBalance(0)
    await expect(readCreditBalance()).resolves.toBe(0)
    await expect(readCreditBalance()).resolves.not.toBeNull()
  })

  it('lets the reading expire, so a daily reset is not refused on stale evidence', async () => {
    // The failure this prevents: the budget refills at some hour the host does
    // not publish. Without expiry, an exhausted reading recorded before the reset
    // would keep refusing claimants against a full budget, indefinitely, and the
    // only symptom would be users being told to come back later forever.
    await recordCreditBalance(12)
    await expect(readCreditBalance()).resolves.toBe(12)

    vi.advanceTimersByTime(TTL_MS + 1)
    await expect(readCreditBalance()).resolves.toBeNull()
  })

  it('still trusts the reading just before it expires', async () => {
    // The other side of the boundary. Expiring early would widen the window in
    // which the gauge knows nothing, and unknown admits — which is exactly the
    // window an attacker would want.
    await recordCreditBalance(12)
    vi.advanceTimersByTime(TTL_MS - 1_000)
    await expect(readCreditBalance()).resolves.toBe(12)
  })

  it('refreshes the expiry on every write, so an active service never goes unknown', async () => {
    await recordCreditBalance(50_000)
    vi.advanceTimersByTime(TTL_MS - 1_000)
    await recordCreditBalance(40_000)
    vi.advanceTimersByTime(TTL_MS - 1_000)
    // Would already be null if the second write had not restarted the clock.
    await expect(readCreditBalance()).resolves.toBe(40_000)
  })

  it('ignores a reading that is not a usable number', async () => {
    // `x-credits-remaining` is someone else's header. A junk value must leave the
    // last good reading in place rather than overwrite it with a fiction, in
    // either direction.
    await recordCreditBalance(30_000)
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      await recordCreditBalance(bad)
      await expect(readCreditBalance()).resolves.toBe(30_000)
    }
  })

  it('stores an integer, so a fractional reading does not round upward', async () => {
    // Rounding up would overstate the remaining budget, which is the direction
    // that spends credits we do not have.
    await recordCreditBalance(999.9)
    await expect(readCreditBalance()).resolves.toBe(999)
  })

  it('overwrites rather than accumulating, since only the latest reading is true', async () => {
    await recordCreditBalance(50_000)
    await recordCreditBalance(49_000)
    await expect(readCreditBalance()).resolves.toBe(49_000)
    // And a rise is legitimate: that is the daily reset, not a bug.
    await recordCreditBalance(100_000)
    await expect(readCreditBalance()).resolves.toBe(100_000)
  })
})
