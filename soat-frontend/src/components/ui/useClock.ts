'use client'

/**
 * The wall clock, as an external store.
 *
 * One job: hand render a monotonically-advancing timestamp without ever
 * calling `Date.now()` during render.
 *
 * NON-OBVIOUS CONSTRAINTS
 *
 *   1. Before the first client tick these hooks return `CLOCK_UNSYNCED` (0),
 *      on the server and on the hydration pass alike.  That is deliberate:
 *      seeding state with `Date.now()` makes the server and client snapshots
 *      disagree by definition.  Treat 0 as "wall time not known yet" and
 *      render a placeholder, exactly as UserDrawer's `knowsWallTime` already
 *      does — never as "1970".
 *
 *   2. Timers are shared per cadence, module-wide.  Twenty components on the
 *      one-second cadence run one interval between them, and it is torn down
 *      when the last subscriber leaves.
 *
 *   3. `active: false` parks a subscriber on the frozen store rather than
 *      spinning a timer it cannot see — the drawer's "only tick while open"
 *      behaviour, generalised.
 *
 * REPLACES (Phase 2 should delete these and import from here):
 *   • ProjectTerminal.tsx      — `useState(() => Date.now()/1000)` + 1s setInterval
 *   • admin/page.tsx           — local `useNowSec(intervalMs = 15_000)`
 *   • UserDrawer.tsx           — `useRafClock(active)`, ms, rAF-driven
 *   • meritx/InvestLeftPanel   — `useState(0)` + 1s setInterval
 *   • meritx/useDirectoryProjects — `useState(0)` + 1s setInterval
 *   • meritx/MeritXProjectCard — `Date.now()` inside its own tick
 */

import { useSyncExternalStore } from 'react'

/** Wall time is not known yet. Never render this as a date. */
export const CLOCK_UNSYNCED = 0

/**
 * How often the clock reports a new value.
 *   'second' — 1 000 ms, the default; countdowns, cooldowns, deadlines.
 *   'frame'  — requestAnimationFrame; only for sub-second readouts such as
 *              the drawer's HH:MM:SS_cs counter.
 *   number   — an explicit interval in ms, for slow polls (admin used 15 000).
 */
export type ClockCadence = 'second' | 'frame' | number

interface ClockStore {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => number
}

const FROZEN: ClockStore = {
  subscribe: () => () => {},
  getSnapshot: () => CLOCK_UNSYNCED,
}

const getServerSnapshot = (): number => CLOCK_UNSYNCED

const stores = new Map<ClockCadence, ClockStore>()

function createStore(cadence: ClockCadence): ClockStore {
  const listeners = new Set<() => void>()
  let value = CLOCK_UNSYNCED
  let stop: (() => void) | null = null

  const publish = () => {
    value = Date.now()
    for (const listener of listeners) listener()
  }

  const start = () => {
    if (cadence === 'frame') {
      let raf = requestAnimationFrame(function tick() {
        publish()
        raf = requestAnimationFrame(tick)
      })
      return () => cancelAnimationFrame(raf)
    }
    const ms = cadence === 'second' ? 1_000 : Math.max(16, cadence)
    // Publish once immediately so a freshly-mounted subscriber does not stare
    // at CLOCK_UNSYNCED for a whole interval.
    const kickoff = setTimeout(publish, 0)
    const id = setInterval(publish, ms)
    return () => {
      clearTimeout(kickoff)
      clearInterval(id)
    }
  }

  return {
    subscribe: (onChange) => {
      listeners.add(onChange)
      if (stop === null) stop = start()
      return () => {
        listeners.delete(onChange)
        if (listeners.size === 0 && stop !== null) {
          stop()
          stop = null
          // Drop the stale reading so the next subscriber re-syncs rather than
          // rendering a timestamp from whenever this cadence last ran.
          value = CLOCK_UNSYNCED
        }
      }
    },
    getSnapshot: () => value,
  }
}

function getStore(cadence: ClockCadence, active: boolean): ClockStore {
  if (!active) return FROZEN
  let store = stores.get(cadence)
  if (store === undefined) {
    store = createStore(cadence)
    stores.set(cadence, store)
  }
  return store
}

/** Unix milliseconds, or `CLOCK_UNSYNCED` before the first client tick. */
export function useNowMs(cadence: ClockCadence = 'second', active = true): number {
  const store = getStore(cadence, active)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot)
}

/**
 * Unix seconds, or `CLOCK_UNSYNCED` before the first client tick.
 *
 * This is the one every countdown, cooldown and deadline comparison should
 * use.  Compare against a `bigint` timestamp with `BigInt(nowSec)`.
 */
export function useNowSec(cadence: ClockCadence = 'second', active = true): number {
  const ms = useNowMs(cadence, active)
  return ms === CLOCK_UNSYNCED ? CLOCK_UNSYNCED : Math.floor(ms / 1_000)
}

/**
 * True once the component has hydrated on the client.
 *
 * Replaces the `const [mounted, setMounted] = useState(false); useEffect(...)`
 * pattern repeated in ProjectTerminal, WalletPip, NetworkGuard and
 * launch/page.  No effect, so it cannot trip `react-hooks/set-state-in-effect`.
 */
const noopSubscribe = () => () => {}

export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}
