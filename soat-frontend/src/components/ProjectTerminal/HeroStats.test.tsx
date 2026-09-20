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
 * Whether `pct` counts down or up is decided in `genesisWindow` and pinned in
 * genesisWindow.test.ts — the component is handed a number and has no opinion
 * about which direction it came from.
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

function render(phase: Phase, genesisWindow?: { pct: number; label: string; hours: number }) {
  return mount(<HeroStats {...BASE} phase={phase} genesisWindow={genesisWindow} />)
}

describe('HeroStats genesis countdown', () => {
  it('draws the track at the fraction it is given, and the countdown beside it', () => {
    const { container } = render('genesis', { pct: 25, label: '06:00:00 left', hours: 24 })
    const track = bar(container)
    expect(track).not.toBeNull()
    expect(track!.getAttribute('aria-valuenow')).toBe('25')
    expect(container.textContent).toContain('06:00:00 left')
  })

  it('exposes the fraction to assistive tech, not just to the eye', () => {
    const { container } = render('genesis', { pct: 100, label: '72:00:00 left', hours: 72 })
    const track = bar(container)!
    expect(track.getAttribute('aria-valuenow')).toBe('100')
    expect(track.getAttribute('aria-valuemin')).toBe('0')
    expect(track.getAttribute('aria-valuemax')).toBe('100')
  })

  it('names the window length, so the fraction has a stated denominator', () => {
    const { container } = render('genesis', { pct: 50, label: '01:30:00 left', hours: 3 })
    expect(container.textContent).toContain('3h window')
  })

  it('still shows the raised figure beside the clock', () => {
    const { container } = render('genesis', { pct: 50, label: '12:00:00 left', hours: 24 })
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
})
