// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

import { GasHistoryDialog } from './GasHistoryDialog'
import type { PogChainSpend, PogScanResult } from './pogScanClient'
import type { PogLookupPhase } from './usePogFlow'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the gas-history dialog.
 *
 * Taken before its copy moves into the dictionary. The dialog is mounted by
 * `PogLookupProvider` on every page, so it is the first thing a newly connected
 * wallet reads about eligibility; each phase and each closing verdict is
 * rendered on its own below.
 */

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}))

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const E15 = 10n ** 15n

type Scan = PogScanResult & { totalGasWei: string; chains: PogChainSpend[] }

function row(chainId: number, chain: string, over: Partial<PogChainSpend> = {}): PogChainSpend {
  return { chainId, chain, gasWei: String(12n * E15), sentTxs: 1234, ...over } as PogChainSpend
}

function scan(over: Partial<Scan> = {}): Scan {
  return {
    eligible: true,
    totalGasWei: String(500n * E15),
    floorWei: String(25n * E15),
    maxAllocWei: '116000000',
    truncated: false,
    chains: [
      row(1, 'Ethereum'),
      row(42161, 'Arbitrum', { truncated: true }),
      row(10, 'Optimism', { skipped: true }),
      row(56, 'BSC', { unavailable: true }),
    ],
    ...over,
  } as Scan
}

function render(props: {
  phase: PogLookupPhase
  scan?: Scan | null
  error?: string | null
  onRetry?: () => void
  quotaKnown?: boolean
  onActivate?: () => void
  activating?: boolean
}) {
  return mount(
    <GasHistoryDialog
      open
      onClose={() => {}}
      userAddress={USER}
      scan={props.scan ?? null}
      error={props.error ?? null}
      {...props}
    />,
  )
}

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('GasHistoryDialog · english copy golden master', () => {
  it('scanning', () => {
    pin(render({ phase: 'scanning' }))
  })

  it('failed, with an error and a retry', () => {
    pin(render({ phase: 'failed', error: 'Unsupported chain (got 4663)', onRetry: () => {} }))
  })

  it('failed, with no error and no retry', () => {
    pin(render({ phase: 'failed' }))
  })

  it('eligible, can activate', () => {
    pin(render({ phase: 'ready', scan: scan(), onActivate: () => {} }))
  })

  it('eligible, activating', () => {
    pin(render({ phase: 'ready', scan: scan(), onActivate: () => {}, activating: true }))
  })

  it('eligible, quota already on file', () => {
    pin(render({ phase: 'ready', scan: scan() }))
  })

  it('eligible, quota not read yet', () => {
    pin(render({ phase: 'ready', scan: scan(), quotaKnown: false }))
  })

  it('below the floor, one chain missing', () => {
    pin(render({
      phase: 'ready',
      scan: scan({ eligible: false, totalGasWei: String(3n * E15), maxAllocWei: undefined, unavailableChains: ['BSC'] }),
    }))
  })

  it('two chains missing', () => {
    pin(render({ phase: 'ready', scan: scan({ unavailableChains: ['BSC', 'Robinhood'] }) }))
  })
})
