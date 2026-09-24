// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the referral desk.
 *
 * Taken before its copy moves into the dictionary. What the link is worth is
 * three different sentences depending on two reads, and the claim block has
 * its own three states; each is rendered on its own below, plus the copy
 * button after a click.
 */

type Reads = {
  claimableReferral?: bigint
  referralAccrued?: bigint
  pogQuota?: bigint
  canBindProjectReferral?: boolean
}

let reads: Reads = {}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER, isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useReadContract: ({ functionName }: { functionName: keyof Reads }) => ({
    data: reads[functionName], refetch: vi.fn(),
  }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
}))

import { ReferralPanel } from './ReferralPanel'

const USER = '0x35b232E26a275f62E594e010624aEA0c46b7874a' as Address
const HOOK = '0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409' as Address
const E18 = 10n ** 18n

function render(phase: 'genesis' | 'bonding') {
  return mount(
    <ReferralPanel hookAddress={HOOK} symbol="TEST" userAddress={USER} refetch={() => {}} phase={phase} />,
  )
}

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

beforeEach(() => {
  reads = {}
  // Refusing the short-code POST keeps the long `?ref=` link, which every
  // wallet has from the start.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
})

describe('ReferralPanel · english copy golden master', () => {
  const cases: [string, 'genesis' | 'bonding', Reads][] = [
    ['reads in flight', 'genesis', {}],
    ['unattested, pays nothing', 'genesis', { pogQuota: 0n, canBindProjectReferral: false }],
    ['project leg dark, pays the lifetime leg only', 'genesis', { pogQuota: 1n, canBindProjectReferral: false }],
    ['pays the full rate', 'genesis', { pogQuota: 1n, canBindProjectReferral: true, claimableReferral: 0n, referralAccrued: 0n }],
    ['earned, locked until launch', 'genesis', {
      pogQuota: 1n, canBindProjectReferral: true, claimableReferral: 0n, referralAccrued: 5n * 10n ** 7n,
    }],
    ['claimable after launch', 'bonding', {
      pogQuota: 1n, canBindProjectReferral: true, claimableReferral: 123_45678901n, referralAccrued: 123_45678901n,
    }],
    ['claimable, large', 'bonding', {
      pogQuota: 1n, canBindProjectReferral: true, claimableReferral: 1_000_000n * E18, referralAccrued: 0n,
    }],
  ]

  for (const [name, phase, r] of cases) {
    it(name, () => {
      reads = r
      const ui = render(phase)
      try { pin(ui) } finally { ui.unmount() }
    })
  }

  it('after copying', async () => {
    reads = { pogQuota: 1n, canBindProjectReferral: true }
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } })
    const ui = render('genesis')
    try {
      await act(async () => { ui.button('copy').click() })
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
      pin(ui)
    } finally {
      ui.unmount()
      vi.unstubAllGlobals()
    }
  })
})
