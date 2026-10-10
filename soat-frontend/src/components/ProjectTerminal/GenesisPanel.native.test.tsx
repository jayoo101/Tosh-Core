// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'
import { FACTORY_ADDRESS } from '@/lib/contracts'
import { WBNB_BSC } from '@/lib/quoteAssets'

import { GenesisPanel, type GenesisProps } from './GenesisPanel'
import { QuoteProvider } from './quoteContext'

/**
 * A WBNB project takes BNB: the deposit is `factory.depositNative{value}`, with
 * no approval step, and the balance it checks is the wallet's BNB.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOOK = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const E18 = 10n ** 18n
const NOW = 1_700_000_000

const writes = vi.hoisted(() => ({ writeContract: vi.fn(), allowance: 0n }))

const stable = {
  setDialogOpen: vi.fn(),
  startLookup: vi.fn(async () => {}),
  registerQuota: vi.fn(async () => {}),
  bindRefetch: vi.fn(),
}

vi.mock('./PogLookupProvider', () => ({
  usePogLookup: () => ({
    userAddress: USER, phase: 'idle', scan: undefined, error: null, dialogOpen: false,
    registering: false, isPending: false, isConfirming: false, ...stable,
  }),
}))

vi.mock('@/lib/useReferral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/useReferral')>()),
  resolveReferrerNow: () => ZERO,
  useReferralCode: () => ({ code: null, state: 'none' as const }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER, isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  // No allowance at all: a native deposit must not ask for one.
  useReadContract: () => ({ data: writes.allowance, refetch: vi.fn() }),
  useWriteContract: () => ({
    writeContract: writes.writeContract, writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, error: null }),
  usePublicClient: () => ({ readContract: vi.fn() }),
}))

const WBNB_QUOTE = { asset: WBNB_BSC, decimals: 18, symbol: 'BNB', wrapsNative: true }

const BASE: GenesisProps = {
  hookAddress: HOOK,
  symbol: 'QMT',
  userAddress: USER,
  isConnected: true,
  totalNativeDeposited: 0n,
  quoteBalance: 0n,
  nativeBalance: 5n * E18,
  pogQuota: 13n * E18 / 10n,
  quotaRemaining: 13n * E18 / 10n,
  blacklistedUntil: 0n,
  cooldownEnd: 0n,
  nowSec: NOW,
  perWalletCap: 13n * E18 / 10n,
  userDeposited: 0n,
  genesisDeadline: BigInt(NOW + 86_400),
  referrer: ZERO,
  refetch: () => {},
}

function render(over: Partial<GenesisProps> = {}) {
  return mount(
    <QuoteProvider value={WBNB_QUOTE}>
      <GenesisPanel {...BASE} {...over} />
    </QuoteProvider>,
  )
}

beforeEach(() => { writes.writeContract.mockClear() })

describe('genesis deposit on a WBNB project', () => {
  it('sends depositNative with the amount as value, and never asks to approve', () => {
    const ui = render()
    try {
      ui.type('1.25')
      const text = ui.text()
      expect(text).not.toMatch(/approve/i)
      const enabled = ui.buttons().filter(b => !b.disabled && /deposit/i.test(b.textContent ?? ''))
      expect(enabled.length).toBeGreaterThan(0)
      act(() => { enabled[0].click() })

      expect(writes.writeContract).toHaveBeenCalledTimes(1)
      const req = writes.writeContract.mock.calls[0][0]
      expect(req.address).toBe(FACTORY_ADDRESS)
      expect(req.functionName).toBe('depositNative')
      expect(req.args).toEqual([HOOK, ZERO])
      expect(req.value).toBe(125n * E18 / 100n)
    } finally { ui.unmount() }
  })

  it('refuses an amount the BNB balance cannot cover with gas left over', () => {
    const ui = render({ nativeBalance: 1n * E18 })
    try {
      ui.type('1')
      const enabled = ui.buttons().filter(b => !b.disabled && /deposit/i.test(b.textContent ?? ''))
      expect(enabled).toHaveLength(0)
      expect(writes.writeContract).not.toHaveBeenCalled()
    } finally { ui.unmount() }
  })
})
