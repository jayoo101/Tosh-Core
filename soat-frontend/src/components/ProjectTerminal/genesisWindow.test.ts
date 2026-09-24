import { describe, expect, it, vi } from 'vitest'

// `phase.ts` pulls `LAUNCH_WINDOW_SECONDS` from `contracts.ts`, which throws at
// import without a factory address. Hoisting beats the static import below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { genesisWindow } from './phase'

/**
 * The genesis cell used to hold a bar filling toward the soft cap, and the
 * soft cap gates nothing — deposits run past it and `launch()` never reads it.
 * A clock took the slot because a clock has a denominator the cap never had.
 *
 * ⚠ THE DIRECTION IS THE POINT OF THIS FILE. `elapsedPct` is what has GONE, so
 *   it advances left to right as the window burns down. Remaining also renders
 *   and also animates, and nothing about reading the diff catches an inversion,
 *   so it is pinned at both ends and in the middle.
 *
 *   It was pinned the other way first, on the theory that a filling bar reads
 *   as progress toward a goal — the soft-cap bar's misreading. On screen the
 *   opposite dominated: a value that retreats leftward beside a counting-down
 *   clock reads as running backwards, since every elapsed-time bar people
 *   already use advances left to right.
 *
 *   What this number MEANS on screen is settled in `Progress` and not here: it
 *   places the flame on a fuse, and the lit stretch is the part ahead of it, so
 *   the bright band shrinks rightward as this number grows. That is what
 *   finally answered the filling-bar objection — the shape stopped being a fill
 *   at all — and it is also why this file only pins the number. A test that
 *   asserted "the track fills" would have gone stale on a change that did not
 *   touch the arithmetic.
 */

const HOUR = 3600
const DAY = 24 * HOUR

/** A 24h window opened at t=1000, sampled `elapsed` seconds in. */
function at(elapsed: number, duration = DAY) {
  const opened = 1000
  return genesisWindow({
    phase: 'genesis',
    genesisDeadline: BigInt(opened + duration),
    genesisDuration: BigInt(duration),
    nowSec: opened + elapsed,
  })
}

describe('genesisWindow', () => {
  it('fills rather than drains', () => {
    expect(at(0)!.elapsedPct).toBe(0)
    expect(at(DAY / 4)!.elapsedPct).toBe(25)
    expect(at(DAY / 2)!.elapsedPct).toBe(50)
    expect(at(DAY - HOUR)!.elapsedPct).toBeCloseTo(100 - 100 / 24, 6)
  })

  it('starts empty, which is the assertion an inversion breaks first', () => {
    // A window that has just opened must draw NO fill. Under the old direction
    // this same instant drew a full bar, so it is the cheapest single check
    // that the complement has not crept back in.
    for (const duration of [3 * HOUR, DAY, 3 * DAY]) {
      expect(at(0, duration)!.elapsedPct).toBe(0)
      expect(at(duration - 1, duration)!.elapsedPct).toBeGreaterThan(99)
    }
  })

  it('is monotonically increasing as the window runs down', () => {
    let previous = -1
    for (let t = 0; t < DAY; t += HOUR) {
      const pct = at(t)!.elapsedPct
      expect(pct).toBeGreaterThan(previous)
      previous = pct
    }
  })

  it('formats the remainder as a zero-padded countdown', () => {
    expect(at(0, 3 * HOUR)!.clock).toBe('03:00:00')
    expect(at(3 * HOUR - 1, 3 * HOUR)!.clock).toBe('00:00:01')
    expect(at(DAY - (9 * HOUR + 5 * 60 + 3))!.clock).toBe('09:05:03')
  })

  it('reports the window length the fraction is measured against', () => {
    expect(at(0, 3 * HOUR)!.hours).toBe(3)
    expect(at(0, DAY)!.hours).toBe(24)
    expect(at(0, 3 * DAY)!.hours).toBe(72)
  })

  it('draws nothing rather than a zeroed bar when there is no window to show', () => {
    // Zero now means "just opened" rather than "over", which makes returning
    // `undefined` load-bearing in a second way: a 0 for an expired or
    // not-yet-polled window would draw a bar claiming the raise has not started.
    expect(at(DAY)).toBeUndefined()
    expect(at(DAY + 1)).toBeUndefined()

    for (const phase of ['awaiting_launch', 'bonding', 'refund'] as const) {
      expect(
        genesisWindow({
          phase,
          genesisDeadline: BigInt(1000 + DAY),
          genesisDuration: BigInt(DAY),
          nowSec: 1000,
        }),
        `${phase} must not draw a genesis clock`,
      ).toBeUndefined()
    }
  })

  it('draws nothing before the first poll resolves the deadline', () => {
    // `genesisDeadline` is 0n until the read lands, and `resolvePhase` calls
    // that 'genesis'. A deadline in the past makes `remaining` negative, so the
    // guard that catches an expired window catches an unresolved one too.
    expect(
      genesisWindow({ phase: 'genesis', genesisDeadline: 0n, genesisDuration: BigInt(DAY), nowSec: 1000 }),
    ).toBeUndefined()
    expect(
      genesisWindow({ phase: 'genesis', genesisDeadline: BigInt(1000 + DAY), genesisDuration: 0n, nowSec: 1000 }),
    ).toBeUndefined()
  })
})
