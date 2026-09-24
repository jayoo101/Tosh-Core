// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · /referrals.
 *
 * Taken before the ledger's copy moves into the dictionary. Every row state is
 * rendered — claimable, locked in genesis, fully withdrawn, recruits only, and
 * a row whose reads failed — plus the page's own empty, loading, disconnected
 * and truncated-scan states.
 */

const USER = '0x35b232E26a275f62E594e010624aEA0c46b7874a' as Address

type Leg = bigint | 'fail'
interface Row { symbol: string; launched: boolean; accrued: Leg; claimable: Leg; recruits: Leg }

let s: {
  connected: boolean
  loading:   boolean
  rows:      Row[]
  launchCount: number
  lifetime:  bigint
}

const hookOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address
const tokenOf = (i: number) => `0x${(i + 101).toString(16).padStart(40, '0')}` as Address

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: s.connected ? USER : undefined, isConnected: s.connected, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useReadContract: () => ({ data: s.lifetime, refetch: vi.fn() }),
  useReadContracts: () => ({
    data: s.loading ? undefined : s.rows.flatMap(r => [r.accrued, r.claimable, r.recruits].map(v => (
      v === 'fail' ? { status: 'failure', error: new Error('x') } : { status: 'success', result: v }
    ))),
    isLoading: s.loading,
    refetch: vi.fn(),
  }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
}))

vi.mock('@/components/directory/useDirectoryProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/directory/useDirectoryProjects')>()),
  useDirectoryProjects: () => ({
    projects: s.rows.map((r, i) => ({
      token: tokenOf(i), hook: hookOf(i), creator: USER, createdAt: 0n,
      launched: r.launched, genesisDeadline: 0n, genesisDuration: 0n, totalNative: 0n,
      canRefund: false, symbol: r.symbol, name: `${r.symbol} Agent`,
      logoUrl: null, website: null, twitter: null, description: null,
    })),
    counts: {}, loading: false, refetch: vi.fn(), launchCount: s.launchCount,
  }),
}))

import { ReferralLedger } from './ReferralLedger'

const Q = 10n ** 8n

beforeEach(() => {
  s = { connected: true, loading: false, rows: [], launchCount: 3, lifetime: 0n }
})

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

function renderPinned() {
  const ui = mount(<ReferralLedger />)
  try { pin(ui) } finally { ui.unmount() }
}

describe('/referrals · english copy golden master', () => {
  it('no wallet', () => {
    s.connected = false
    renderPinned()
  })

  it('reading the ledger', () => {
    s.loading = true
    s.rows = [{ symbol: 'AAA', launched: true, accrued: 1n, claimable: 1n, recruits: 1n }]
    renderPinned()
  })

  it('nothing owed', () => {
    s.rows = [{ symbol: 'AAA', launched: false, accrued: 0n, claimable: 0n, recruits: 0n }]
    renderPinned()
  })

  it('every row state', () => {
    s.lifetime = 7n
    s.rows = [
      { symbol: 'CLM', launched: true,  accrued: 12n * Q, claimable: 12n * Q, recruits: 3n },
      { symbol: 'LCK', launched: false, accrued: 5n * Q,  claimable: 0n,      recruits: 2n },
      { symbol: 'WDN', launched: true,  accrued: 4n * Q,  claimable: 0n,      recruits: 1n },
      { symbol: 'RCR', launched: false, accrued: 0n,      claimable: 0n,      recruits: 1n },
      { symbol: 'DEG', launched: true,  accrued: 2n * Q,  claimable: 'fail',  recruits: 0n },
    ]
    renderPinned()
  })

  it('the scan stopped short', () => {
    s.launchCount = 60
    s.rows = [{ symbol: 'LCK', launched: false, accrued: 5n * Q, claimable: 0n, recruits: 2n }]
    renderPinned()
  })
})
