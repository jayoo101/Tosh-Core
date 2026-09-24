// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { HeroStats } from './HeroStats'
import type { Phase } from './phase'

// `contracts.ts` throws at import without a factory address, and this file
// reaches it through `@/components/ui`. Hoisting is the only place early
// enough to beat the static imports above; see PogScanButton.test.tsx.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * The genesis cell held a bar filling toward the soft cap, and the soft cap
 * gates nothing — deposits run past it and `launch()` never reads it. It now
 * holds a clock instead, which is a fraction of something real: one of three
 * fixed windows chosen at `createLaunch`.
 *
 * SCOPE. This file covers the drawing only: which phases get a meter, that the
 * raise keeps its figure beside the clock, and that the two meters never stack.
 * Whether the fraction counts down or up is decided in `genesisWindow` and
 * pinned in genesisWindow.test.ts — the component is handed a number and has no
 * opinion about which direction it came from.
 *
 * The fixtures below are still kept CONSISTENT with that direction (an
 * `elapsedPct` of 25 pairs with three quarters of the window still on the
 * clock), because a fixture that contradicts it is the first thing a reader
 * will copy when they go looking for what the number means.
 */

const BASE = {
  symbol: 'RHRSL',
  p0: 1_000n,
  currentPrice: 0n,
  shelfP0: 0n,
  totalNativeDeposited: 500n,
  phase2Minted: 0n,
  bondingMax: 12_600_000n,
  userEthDeposited: 0n,
}

function bar(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="progressbar"]')
}

function render(phase: Phase, genesisWindow?: { elapsedPct: number; clock: string; hours: number }) {
  return mount(<HeroStats {...BASE} phase={phase} genesisWindow={genesisWindow} />)
}

describe('HeroStats genesis countdown', () => {
  it('draws the track at the fraction it is given, and the countdown beside it', () => {
    const { container } = render('genesis', { elapsedPct: 25, clock: '18:00:00', hours: 24 })
    const track = bar(container)
    expect(track).not.toBeNull()
    expect(track!.getAttribute('aria-valuenow')).toBe('25')
    expect(container.textContent).toContain('18:00:00 left')
  })

  it('exposes the fraction to assistive tech, not just to the eye', () => {
    const { container } = render('genesis', { elapsedPct: 99, clock: '00:43:12', hours: 72 })
    const track = bar(container)!
    expect(track.getAttribute('aria-valuenow')).toBe('99')
    expect(track.getAttribute('aria-valuemin')).toBe('0')
    expect(track.getAttribute('aria-valuemax')).toBe('100')
  })

  it('names the window length, so the fraction has a stated denominator', () => {
    const { container } = render('genesis', { elapsedPct: 50, clock: '01:30:00', hours: 3 })
    expect(container.textContent).toContain('3h window')
  })

  it('still shows the raised figure beside the clock', () => {
    const { container } = render('genesis', { elapsedPct: 50, clock: '12:00:00', hours: 24 })
    expect(container.textContent).toContain('Raised')
  })

  it('draws no bar once genesis is over, even though the raise is unchanged', () => {
    for (const phase of ['awaiting_launch', 'refund'] as const) {
      const { container } = render(phase)
      expect(bar(container), `${phase} should have no meter`).toBeNull()
      expect(container.textContent).toContain('Raised')
    }
  })

  it('gives the ladder the bar during bonding, and does not stack two meters', () => {
    const { container } = mount(
      <HeroStats {...BASE} phase="bonding" phase2Minted={6_300_000n} />,
    )
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    expect(container.textContent).toContain('Ladder')
    expect(container.textContent).not.toContain('Raised')
  })

  /*
   * `totalNativeDeposited` NEVER FALLS. `refund()` zeroes the per-wallet entry
   * and leaves the total alone on purpose, because `claimTokens` divides by it
   * — so a round refunded down to zero reports its peak forever, and this cell
   * was printing that peak under the present-tense label "Raised" beside a
   * REFUND OPEN badge. A depositor reading it was told the money was in.
   *
   * The fixtures below all keep `totalNativeDeposited` at its peak while the
   * balance varies, because that IS the state being tested: the two figures
   * disagreeing is the normal case in this phase, not a contrived one.
   */
  describe('once refunds open', () => {
    function refund(hookQuoteBalance?: bigint) {
      return mount(
        <HeroStats {...BASE} phase="refund" hookQuoteBalance={hookQuoteBalance} />,
      )
    }

    it('stops calling the peak a present-tense balance', () => {
      const { container } = refund(0n)
      expect(container.textContent).toContain('Raised at genesis')
    })

    it('says the money is gone when the hook is empty, rather than implying it is in', () => {
      const { container } = refund(0n)
      expect(container.textContent).toContain('every refund paid out')
      // The peak is still drawn — it is a true historical figure and the label
      // now scopes it. What must not survive is it standing alone.
      //
      // `5.00e-6`, not `500`: the fixture is 500 raw units on the quote
      // asset's 8-decimal scale. See the p0 case at the bottom of this file.
      expect(container.textContent).toContain('5.00e-6')
    })

    it('states what is left when refunds are still outstanding', () => {
      const { container } = refund(120n)
      expect(container.textContent).toContain('still waiting to be claimed')
      expect(container.textContent).not.toContain('every refund paid out')
    })

    /*
     * The failure this guards is a verdict printed on a guess. `0n` and "not
     * read yet" render the same if the prop is coalesced anywhere on the way
     * in, and the coalesced answer is the alarming one: a hook still holding
     * every depositor's money, captioned as fully refunded.
     */
    it('claims nothing while the balance read is in flight', () => {
      const { container } = refund(undefined)
      expect(container.textContent).toContain('reading what is left')
      expect(container.textContent).not.toContain('every refund paid out')
    })

    it('does not caption an empty stake as claimable', () => {
      const { container } = refund(0n)
      expect(container.textContent).toContain('nothing to claim here')
      expect(container.textContent).not.toContain('claimable in full')
    })

    it('still offers the refund to a wallet that has a deposit', () => {
      const { container } = mount(
        <HeroStats {...BASE} phase="refund" userEthDeposited={250n} hookQuoteBalance={250n} />,
      )
      expect(container.textContent).toContain('claimable in full')
      expect(container.textContent).not.toContain('nothing to claim here')
    })
  })

  /*
   * The outstanding line sits in the slot the countdown uses, so the two are
   * mutually exclusive by phase rather than by layout. Worth pinning: the
   * cheapest way to regress it is to drop the `phase === 'refund'` guard and
   * let the line render everywhere, which looks fine in genesis review
   * because the countdown is the thing being looked at.
   */
  it('keeps the outstanding line out of every phase but refund', () => {
    for (const phase of ['genesis', 'awaiting_launch', 'bonding'] as const) {
      const { container } = mount(
        <HeroStats {...BASE} phase={phase} hookQuoteBalance={0n} />,
      )
      expect(container.textContent, phase).not.toContain('every refund paid out')
      expect(container.textContent, phase).not.toContain('Raised at genesis')
    }
  })

  /*
   * ENGLISH GOLDEN MASTER · taken before this card's copy moves into a
   * translation dictionary, and its only job is to stay unchanged while it does.
   *
   * ⚠ RED DURING THE i18n WORK MEANS STOP, not `-u`. The extraction is not
   *   allowed to change a word a user reads — that premise is the whole reason
   *   it is safe to do mechanically across sixty files.
   *
   * Every phase gets an entry because this card says something different in each
   * one, and two of those somethings were wrong until recently: the peak
   * captioned as a live balance, and an empty stake captioned "claimable in
   * full". Copy that has already been wrong twice is copy worth pinning.
   */
  describe('english copy · golden master', () => {
    for (const [name, props] of [
      ['genesis · clock running', { phase: 'genesis' as const, genesisWindow: { elapsedPct: 25, clock: '18:00:00', hours: 24 } }],
      ['awaiting launch',         { phase: 'awaiting_launch' as const }],
      ['ladder open',             { phase: 'bonding' as const, phase2Minted: 6_300_000n }],
      ['refund · all paid out',   { phase: 'refund' as const, hookQuoteBalance: 0n }],
      ['refund · still owed',     { phase: 'refund' as const, hookQuoteBalance: 120n, userEthDeposited: 120n }],
    ] as const) {
      it(name, () => {
        const ui = mount(<HeroStats {...BASE} {...props} />)
        expect(ui.strings()).toMatchSnapshot()
      })
    }
  })

  it('draws p0 on the quote scale, not the 18-decimal default', () => {
    // p0 is quote-wei per whole token. 1000n is 0.00001 quote. Drawn at 18
    // decimals it is 1.00e-15 — ten orders small, and still a plausible
    // meme-coin price, which is why the inversion survived a look.
    const { container } = render('genesis')
    expect(container.textContent).toContain('1.00e-5')
    expect(container.textContent).not.toContain('1.00e-15')
  })
})
