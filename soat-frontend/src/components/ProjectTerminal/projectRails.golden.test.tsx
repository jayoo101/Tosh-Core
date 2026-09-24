// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'

import { HeroStats } from './HeroStats'
import { LifecycleTracker } from './LifecycleTracker'
import type { Phase } from './phase'

/**
 * ENGLISH GOLDEN MASTER · the two rails that tell a reader where the raise is.
 *
 * Neither takes money, which is exactly why they are pinned. They are the
 * furniture AROUND the panels that do: the phase badge, the price, the raise, the
 * countdown, this wallet's stake, and the three-step tracker. A reader checks
 * these before deciding whether to type anything, so a translation that quietly
 * changed "Raised" into "Raised at genesis" — the two are one ternary apart in
 * the source — would mislead about whether money is still coming in.
 *
 * ⚠ EVERY PHASE, NOT A REPRESENTATIVE ONE. Both components are almost entirely
 *   ternaries on `phase`, and the strings those ternaries pick between are near
 *   neighbours by design: `'claimable in full'` against `'nothing to claim here'`,
 *   `'active shelf'` against `'genesis P₀'`. A swap between two arms of the same
 *   ternary is the single most likely extraction mistake here and it is invisible
 *   unless both arms are rendered. So the loops below are exhaustive over `Phase`
 *   rather than sampled.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

const PHASES: readonly Phase[] = ['genesis', 'awaiting_launch', 'bonding', 'refund']

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('LifecycleTracker · english copy golden master', () => {
  for (const phase of PHASES) {
    it(phase, () => {
      const ui = mount(<LifecycleTracker phase={phase} />)
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})

describe('HeroStats · english copy golden master', () => {
  const base = {
    symbol: 'QMT',
    p0: 1_0000n,
    currentPrice: 0n,
    shelfP0: 0n,
    totalNativeDeposited: 41_15880000n,
    phase2Minted: 0n,
    bondingMax: 4_000_000_000000000000000000n,
    userEthDeposited: 2_50000000n,
  }

  for (const phase of PHASES) {
    it(phase, () => {
      const ui = mount(<HeroStats {...base} phase={phase} />)
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }

  /*
   * The states the phase loop above cannot reach, each one a string of its own.
   *
   * `refund` carries three different lines depending on what the hook still
   * holds, and the distinction is the point: `undefined` is a read in flight and
   * `0n` is the verdict "every refund has been paid", which must never be printed
   * on a guess. A translation that collapsed them would tell a depositor arriving
   * to collect that there was nothing left for them.
   */
  for (const [name, props] of [
    ['refund · still reading what is left', { phase: 'refund' as Phase, hookQuoteBalance: undefined }],
    ['refund · everything paid out',        { phase: 'refund' as Phase, hookQuoteBalance: 0n }],
    ['refund · money still waiting',        { phase: 'refund' as Phase, hookQuoteBalance: 12_00000000n }],
    ['refund · this wallet already took its money back',
      { phase: 'refund' as Phase, userEthDeposited: 0n, hookQuoteBalance: 12_00000000n }],
    ['genesis · with the window countdown',
      { phase: 'genesis' as Phase, genesisWindow: { elapsedPct: 62, clock: '2d 14h', hours: 168 } }],
    ['awaiting launch · with a status word instead of a clock',
      { phase: 'awaiting_launch' as Phase, windowLabel: 'time up' }],
    ['bonding · a live shelf price',
      { phase: 'bonding' as Phase, currentPrice: 2_5000n, phase2Minted: 1_200_000000000000000000n }],
    ['bonding · no trade yet, so the shelf P₀ stands in',
      { phase: 'bonding' as Phase, currentPrice: 0n, shelfP0: 1_2000n }],
    ['price not open yet', { phase: 'genesis' as Phase, p0: 0n }],
  ] as const) {
    it(name, () => {
      const ui = mount(<HeroStats {...base} {...props} />)
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})
