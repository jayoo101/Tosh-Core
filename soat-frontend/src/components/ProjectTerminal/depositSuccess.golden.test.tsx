// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

import { DepositSuccessDialog } from './DepositSuccessDialog'

/**
 * ENGLISH GOLDEN MASTER · the dialog that fires the instant a deposit confirms.
 *
 * Taken BEFORE its copy moves into the dictionary, for the same reason as
 * `moneyBackCopy.golden.test.tsx`: the extraction must not change a single word
 * a user reads, and that is only provable if the English output is pinned first.
 *
 * ⚠ WHY THIS SURFACE WENT FIRST OF THE REMAINING ONES. A production build with
 *   `NEXT_PUBLIC_LOCALES=zh-CN` renders the deposit panel, the gate and the
 *   transaction toasts in Chinese — and then this dialog, in English, the moment
 *   the money lands. That is the worst placement a language break can have on
 *   this page: the reader is checking that what they just paid for did what they
 *   expected, which is the one moment the page cannot afford to look unfinished.
 *
 * ── What is deliberately NOT mocked ─────────────────────────────────────────
 *
 * `ReferralLinkBox` renders for real, because its default `label` and
 * `copyLabel` are copy this dialog shows without passing them — so they are part
 * of what a reader sees here and have to be pinned here. Only `useReferralLink`
 * is stubbed, since it reaches for a referral code over the network and the link
 * string itself is not copy.
 */

// `src/lib/contracts.ts` throws on import without these, and it is imported for
// the referral basis points this dialog quotes.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

vi.mock('./referralLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./referralLink')>()),
  useReferralLink: () => 'https://toshx.io/r/A1B2C3',
}))

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('DepositSuccessDialog · english copy golden master', () => {
  /*
   * `deposited` is this wallet's stake AFTER the deposit that fired, so it is
   * never zero in the real flow. The two cases below are the two ways the figure
   * formats — a sub-unit amount and a grouped one — because `fmtQuote` is the
   * only thing between the dictionary string and a number a depositor checks
   * against their wallet.
   */
  for (const [name, deposited] of [
    ['a fraction of a coin', 5_000_000n],
    ['a grouped figure', 1_250_00000000n],
  ] as const) {
    it(name, () => {
      const ui = mount(
        <DepositSuccessDialog
          open
          onClose={() => {}}
          userAddress={USER}
          symbol="QMT"
          deposited={deposited}
        />,
      )
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }

  // Closed renders nothing at all, which is worth one line: a dictionary lookup
  // moved above the `if (!open) return null` guard would start rendering copy
  // into a dialog nobody opened, and this is what would catch it.
  it('closed renders no copy', () => {
    const ui = mount(
      <DepositSuccessDialog
        open={false}
        onClose={() => {}}
        userAddress={USER}
        symbol="QMT"
        deposited={1_250_00000000n}
      />,
    )
    try {
      expect(ui.strings()).toEqual([])
      expect(ui.prose()).toBe('')
    } finally { ui.unmount() }
  })
})
