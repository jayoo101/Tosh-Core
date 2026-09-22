import { CLOCK_UNSYNCED } from '@/components/ui/useClock'
import type { DirectoryTab } from './useDirectoryProjects'

/**
 * Which three launches the homepage teaser shows, and which one is drawn widest.
 *
 * Extracted from `AgentDirectoryHome`, where it was a `useMemo` holding a single
 * `.sort()` comparator. It moved when the comparator stopped having one rule:
 * an operator's pin now outranks the raise-size ranking, and a rule with a
 * precedence order in it is worth being able to test without mounting a
 * component that reads 48 launches off a factory. `bucket()` is next door for
 * the same reason.
 *
 * IMPORTED FROM THE CLOCK LEAF, not from `@/components/ui`. The barrel pulls in
 * `contracts.ts`, which throws at module load without `NEXT_PUBLIC_*` env set,
 * so a test of a pure ordering rule would need a stubbed factory address to
 * import it. The same layering the gas-history module keeps for the same reason.
 *
 * Nothing here reads a clock of its own. `nowMs` is passed in because the caller
 * subscribes at a cadence it chooses, and because a pure function is the point.
 */

/** Everything the order depends on, and nothing else, so tests need not fake a launch. */
export interface TeaserCandidate {
  tab: DirectoryTab
  totalNative: bigint
  featuredUntilMs: number | null
}

/** How many cards the block holds: one feature plus the two beside it. */
export const TEASER_SIZE = 3

/**
 * Is this launch's pin still running?
 *
 * `CLOCK_UNSYNCED` honours the pin rather than dropping it, matching how
 * `bucket()` reads a clock that has not ticked: it will not call something
 * expired on the strength of a timestamp it does not have. The common case is a
 * live pin, so honouring it also avoids reordering the cards one tick after
 * they first appear.
 */
export function isPinLive(p: TeaserCandidate, nowMs: number): boolean {
  if (p.featuredUntilMs === null) return false
  return nowMs === CLOCK_UNSYNCED || p.featuredUntilMs > nowMs
}

/**
 * `archived` and `launching` are excluded, and a pin does not override that.
 *
 * This block is an invitation, so a refundable raise or one waiting on its
 * creator is not something a visitor can act on; both are one click away under
 * the phase sidebar on `/projects`. A pin therefore decides ORDER and not
 * eligibility: pinning something ineligible promotes it within a set it is not
 * in and changes nothing, which is why `FeaturedProjectPanel` offers only the
 * eligible launches instead of a free-text address field.
 */
export function isTeaserEligible(p: TeaserCandidate): boolean {
  return p.tab === 'completed' || p.tab === 'live'
}

export function orderTeaser<T extends TeaserCandidate>(
  projects: readonly T[],
  nowMs: number,
): { feature: T | undefined; rest: T[] } {
  const ranked = projects
    .filter(isTeaserEligible)
    .sort((a, b) => {
      const ap = isPinLive(a, nowMs)
      const bp = isPinLive(b, nowMs)
      if (ap !== bp) return ap ? -1 : 1
      // RETURNING 0 ON A TIE IS LOAD BEARING, not laziness about a tie-break.
      // `Array.prototype.sort` is stable, and the list arrives sorted by
      // `createdAt` descending from `useDirectoryProjects`, so equal raises fall
      // back to newest-first. That matters because early in a deployment every
      // raise is 0 and EVERY comparison is this branch. Inventing a tie-break
      // here would silently replace that ordering.
      return a.totalNative === b.totalNative ? 0 : a.totalNative > b.totalNative ? -1 : 1
    })
    .slice(0, TEASER_SIZE)

  const [feature, ...rest] = ranked
  return { feature, rest }
}
