// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the user drawer.
 *
 * Taken before its copy moves into the dictionary. The quota block has three
 * verdicts (headroom, banned, never attested) and the ban two horizons; the
 * cooldown block three states; and every position row shape is rendered —
 * genesis, claimable, claimed, no allocation, unread — plus the claim button's
 * signing and mining labels. The clock is pinned so the countdown is stable.
 */

const USER = '0x35b232E26a275f62E594e010624aEA0c46b7874a' as Address
const NOW_MS = 1_800_000_000_000
const NOW_S = BigInt(NOW_MS / 1000)
const Q = 10n ** 8n
const E18 = 10n ** 18n

type Leg = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }
const ok = (result: unknown): Leg => ({ status: 'success', result })
const bad: Leg = { status: 'failure', error: new Error('x') }

interface Position {
  symbol: string
  deposited: bigint
  launched: boolean
  total: bigint
  claimed: boolean
  claimSupply: bigint
  cooldownEnd: bigint
  degraded?: boolean
}

let s: {
  connected: boolean
  loadingCount: boolean
  quota: bigint
  remaining: bigint
  ban: bigint
  positions: Position[]
  writePending: boolean
  confirming: boolean
}

const hookOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address
const tokenOf = (i: number) => `0x${(i + 101).toString(16).padStart(40, '0')}` as Address

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: s.connected ? USER : undefined, isConnected: s.connected, chainId: 97 }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useReadContract: () => ({
    data: s.loadingCount ? undefined : BigInt(s.positions.length),
    isLoading: s.loadingCount,
  }),
  useReadContracts: ({ contracts }: { contracts: { functionName: string }[] }) => {
    const first = contracts[0]?.functionName
    const r = (data: Leg[] | undefined) => ({ data, isLoading: false, refetch: vi.fn() })
    switch (first) {
      case 'pogQuota':
        return r([ok(s.quota), ok([s.remaining > 0n, s.remaining, 0n]), ok(s.ban)])
      case 'launches':
        return r(s.positions.map((_, i) => ok([tokenOf(i), hookOf(i), USER, 0n])))
      case 'nativeDeposited':
        return r(s.positions.map(p => ok(p.deposited)))
      case 'userLaunchCooldownEnd':
        return r(s.positions.filter(p => p.deposited > 0n).flatMap(p => p.degraded
          ? [ok(p.cooldownEnd), bad, bad, bad, bad, bad]
          : [ok(p.cooldownEnd), ok(p.launched), ok(p.total), ok(p.claimed), ok(p.claimSupply), ok(p.symbol)]))
      default:
        return r(undefined)
    }
  },
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: s.confirming ? `0x${'ab'.repeat(32)}` : undefined,
    isPending: s.writePending, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: s.confirming, isSuccess: false, error: null,
  }),
}))

vi.mock('@/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui')>()),
  useNowMs: () => NOW_MS,
}))

import { UserDrawer } from './UserDrawer'

const GENESIS: Position = {
  symbol: 'GEN', deposited: 50n * Q, launched: false, total: 900n * Q,
  claimed: false, claimSupply: 0n, cooldownEnd: 0n,
}
const CLAIMABLE: Position = {
  symbol: 'CLM', deposited: 100n * Q, launched: true, total: 1000n * Q,
  claimed: false, claimSupply: 8_400_000n * E18, cooldownEnd: 0n,
}

beforeEach(() => {
  s = {
    connected: true, loadingCount: false,
    quota: 1000n * Q, remaining: 400n * Q, ban: 0n,
    positions: [], writePending: false, confirming: false,
  }
})

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

function renderPinned() {
  const ui = mount(<UserDrawer open onClose={() => {}} />)
  try { pin(ui) } finally { ui.unmount() }
}

describe('UserDrawer · english copy golden master', () => {
  it('no wallet, nothing on chain', () => {
    s.connected = false
    renderPinned()
  })

  it('scanning the registry', () => {
    s.loadingCount = true
    renderPinned()
  })

  it('headroom, no positions', () => {
    renderPinned()
  })

  it('never attested', () => {
    s.quota = 0n
    s.remaining = 0n
    renderPinned()
  })

  it('banned until a date', () => {
    s.ban = NOW_S + 3n * 86400n
    renderPinned()
  })

  it('banned for good', () => {
    s.ban = 2n ** 64n
    renderPinned()
  })

  it('every position shape, on cooldown', () => {
    s.positions = [
      { ...GENESIS, cooldownEnd: NOW_S + 3723n },
      CLAIMABLE,
      { ...CLAIMABLE, symbol: 'DON', claimed: true },
      { ...CLAIMABLE, symbol: 'NIL', claimSupply: 0n },
      { ...GENESIS, symbol: 'UNR', degraded: true },
    ]
    renderPinned()
  })

  it('cooldown lapsed', () => {
    s.positions = [{ ...GENESIS, cooldownEnd: NOW_S - 10n }]
    renderPinned()
  })

  it('claim awaiting signature', () => {
    s.writePending = true
    s.positions = [CLAIMABLE]
    renderPinned()
  })

  it('claim mining', () => {
    s.confirming = true
    s.positions = [CLAIMABLE]
    renderPinned()
  })
})
