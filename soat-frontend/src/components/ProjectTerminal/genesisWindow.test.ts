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
 * ⚠ THE DIRECTION IS THE POINT OF THIS FILE. `pct` is what REMAINS. Elapsed
 *   also renders, also animates, and is also wrong: a countdown that fills as
 *   the deadline approaches reads as progress toward something, which is the
 *   precise misreading the soft-cap bar produced. Nothing about a screenshot
 *   catches an inversion here, so it is pinned at both ends and in the middle.
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
  it('drains rather than fills', () => {
    expect(at(0)!.pct).toBe(100)
    expect(at(DAY / 4)!.pct).toBe(75)
    expect(at(DAY / 2)!.pct).toBe(50)
    expect(at(DAY - HOUR)!.pct).toBeCloseTo(100 / 24, 6)
  })

  it('is monotonically non-increasing as the window runs down', () => {
    let previous = 101
    for (let t = 0; t < DAY; t += HOUR) {
      const pct = at(t)!.pct
      expect(pct).toBeLessThan(previous)
      previous = pct
    }
  })

  it('formats the remainder as a zero-padded countdown', () => {
    expect(at(0, 3 * HOUR)!.label).toBe('03:00:00 left')
    expect(at(3 * HOUR - 1, 3 * HOUR)!.label).toBe('00:00:01 left')
    expect(at(DAY - (9 * HOUR + 5 * 60 + 3))!.label).toBe('09:05:03 left')
  })

  it('reports the window length the fraction is measured against', () => {
    expect(at(0, 3 * HOUR)!.hours).toBe(3)
    expect(at(0, DAY)!.hours).toBe(24)
    expect(at(0, 3 * DAY)!.hours).toBe(72)
  })

  it('draws nothing rather than a zeroed bar when there is no window to show', () => {
    // A bar pinned at 0 asserts "this window is over" in phases where that is
    // either untrue or already said better by another panel.
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
    // that 'genesis'. Deriving a fraction from it would put the bar at 0 on
    // every first paint — a window that looks expired the instant it opens.
    expect(
      genesisWindow({ phase: 'genesis', genesisDeadline: 0n, genesisDuration: BigInt(DAY), nowSec: 1000 }),
    ).toBeUndefined()
    expect(
      genesisWindow({ phase: 'genesis', genesisDeadline: BigInt(1000 + DAY), genesisDuration: 0n, nowSec: 1000 }),
    ).toBeUndefined()
  })
})
