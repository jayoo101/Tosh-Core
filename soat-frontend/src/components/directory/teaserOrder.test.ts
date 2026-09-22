import { describe, expect, it } from 'vitest'

import { CLOCK_UNSYNCED } from '@/components/ui/useClock'
import { orderTeaser, type TeaserCandidate } from './teaserOrder'
import type { DirectoryTab } from './useDirectoryProjects'

/**
 * What the homepage teaser shows, and which launch gets the double-width card.
 *
 * Pinned because the rule has a precedence order in it, and because the thing
 * the pin exists to fix is not obvious from the code that computes it: ranking
 * by amount raised means the widest card on the site goes to whoever deposited
 * the most, which early in a deployment is one unit of quote above the leader,
 * and refundable afterwards if the raise misses the ladder threshold. The pin is
 * the editorial override for that, and every test below is about a boundary of
 * it rather than about the sort mechanically working.
 */

const NOW = 1_800_000_000_000

/** Only the three fields the order reads, so a case is a case and not a launch. */
function candidate(
  raised: bigint,
  opts: { tab?: DirectoryTab; pinnedUntil?: number | null } = {},
): TeaserCandidate & { id: string } {
  return {
    id: `${opts.tab ?? 'live'}-${raised}-${opts.pinnedUntil ?? 'none'}`,
    tab: opts.tab ?? 'live',
    totalNative: raised,
    featuredUntilMs: opts.pinnedUntil ?? null,
  }
}

describe('orderTeaser: the computed order', () => {
  it('ranks by amount raised, descending', () => {
    const small = candidate(1n)
    const big = candidate(100n)
    const mid = candidate(50n)

    const { feature, rest } = orderTeaser([small, big, mid], NOW)

    expect(feature).toBe(big)
    expect(rest).toEqual([mid, small])
  })

  it('leaves out the phases a visitor cannot act on', () => {
    // A refundable raise and one waiting on its creator both outrank everything
    // here by size, and neither belongs in an invitation.
    const refundable = candidate(900n, { tab: 'archived' })
    const waiting = candidate(800n, { tab: 'launching' })
    const funding = candidate(1n)

    const { feature, rest } = orderTeaser([refundable, waiting, funding], NOW)

    expect(feature).toBe(funding)
    expect(rest).toEqual([])
  })

  it('holds three, because the right column fits exactly two beside the feature', () => {
    const all = [candidate(5n), candidate(4n), candidate(3n), candidate(2n), candidate(1n)]

    const { rest } = orderTeaser(all, NOW)

    expect(rest).toHaveLength(2)
  })

  it('keeps the input order when raises tie', () => {
    // THE CASE THAT IS ALWAYS THIS ONE EARLY ON: every raise is 0, so every
    // comparison is a tie. The list arrives newest-first from
    // `useDirectoryProjects`, and the comparator returning 0 on a tie is what
    // preserves that, so this is pinning newest-first by way of stability.
    const newest = candidate(0n)
    const older = candidate(0n)
    const oldest = candidate(0n)

    const { feature, rest } = orderTeaser([newest, older, oldest], NOW)

    expect(feature).toBe(newest)
    expect(rest).toEqual([older, oldest])
  })
})

describe('orderTeaser: an operator pin', () => {
  it('takes the feature slot from a larger raise', () => {
    const whale = candidate(1_000n)
    const pinned = candidate(1n, { pinnedUntil: NOW + 3_600_000 })

    const { feature } = orderTeaser([whale, pinned], NOW)

    expect(feature).toBe(pinned)
  })

  it('stops counting once it has expired', () => {
    // The whole reason the column is a timestamp rather than a flag: forgetting
    // returns the page to the computed order instead of freezing a stale
    // promotion in the largest card.
    const whale = candidate(1_000n)
    const lapsed = candidate(1n, { pinnedUntil: NOW - 1 })

    const { feature } = orderTeaser([whale, lapsed], NOW)

    expect(feature).toBe(whale)
  })

  it('expires exactly at its deadline, not a tick later', () => {
    const whale = candidate(1_000n)
    const atTheEdge = candidate(1n, { pinnedUntil: NOW })

    const { feature } = orderTeaser([whale, atTheEdge], NOW)

    expect(feature).toBe(whale)
  })

  it('cannot put an ineligible launch into the block at all', () => {
    // A pin decides ORDER, not eligibility, and this is the boundary that makes
    // that sentence true: pinning a refundable raise promotes it within a set it
    // is not in. Reachable without anyone erring, by pinning a raise while its
    // window is open and letting the window close, which is why the admin panel
    // warns when the current pin has fallen out of the eligible set.
    const pinnedButRefundable = candidate(1n, {
      tab: 'archived',
      pinnedUntil: NOW + 3_600_000,
    })
    const funding = candidate(2n)

    const { feature, rest } = orderTeaser([pinnedButRefundable, funding], NOW)

    expect(feature).toBe(funding)
    expect(rest).toEqual([])
  })

  it('honours a pin before the clock has ticked', () => {
    // `CLOCK_UNSYNCED` is 0, and comparing a real timestamp against it would
    // call every pin expired. `bucket()` reads an unsynced clock the same way:
    // it does not call something expired on the strength of a time it does not
    // have. Honouring is also the no-flash direction, since the common case is
    // a live pin.
    const whale = candidate(1_000n)
    const pinned = candidate(1n, { pinnedUntil: NOW + 3_600_000 })

    const { feature } = orderTeaser([whale, pinned], CLOCK_UNSYNCED)

    expect(feature).toBe(pinned)
  })

  it('ranks two live pins against each other by raise', () => {
    // The route clears other pins when setting one, so this should not arise,
    // but "should not arise" is not "is handled", and the answer has to be an
    // order rather than whichever the filter happened to reach first.
    const smallPin = candidate(1n, { pinnedUntil: NOW + 3_600_000 })
    const bigPin = candidate(9n, { pinnedUntil: NOW + 3_600_000 })
    const biggestUnpinned = candidate(1_000n)

    const { feature, rest } = orderTeaser([smallPin, bigPin, biggestUnpinned], NOW)

    expect(feature).toBe(bigPin)
    expect(rest).toEqual([smallPin, biggestUnpinned])
  })

  it('returns no feature when nothing is eligible, pinned or not', () => {
    const pinnedGhost = candidate(5n, { tab: 'launching', pinnedUntil: NOW + 3_600_000 })

    const { feature, rest } = orderTeaser([pinnedGhost], NOW)

    expect(feature).toBeUndefined()
    expect(rest).toEqual([])
  })
})
