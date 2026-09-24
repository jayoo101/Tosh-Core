// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the shelf ladder and the buy form.
 *
 * Taken before either moves its copy into the dictionary. This is a money
 * path: the buy button's verdict is one of fifteen blockers, each with a label
 * and a reason, and two of them handed each other's `reason` would tell a buyer
 * the wrong cause for refusing their order — both strings still on the page,
 * so nothing but an ordered snapshot notices. Every blocker is rendered on its
 * own below, in the provider's revert order.
 *
 * The chain is faked at the wagmi boundary, keyed by function name, so each
 * case states exactly the reads that put the hook in that state and nothing
 * else. The wallet is connected on the right chain, so the gate falls through
 * `connect` and `switch network` to the domain blockers under test.
 */

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOOK = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const NOW = 1_700_000_000
const E18 = 10n ** 18n

type TierStatus = readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]

interface Chain {
  tierStatus: TierStatus
  maxMintable: bigint | undefined
  halted: boolean
  globalHaltEnd: bigint
  hookHaltEnd: bigint
  lastSwapBlock: bigint
  block: bigint
  quote: bigint | undefined
  quoteFailed: boolean
  allowance: bigint
}

/** An open ladder with capacity, a quote and allowance: nothing blocks. */
function openLadder(): Chain {
  return {
    tierStatus: [12n, 2_5000n, 300_000n * E18, 2_4000n, 2_3800n, 2_5200n, true],
    maxMintable: 50_000n * E18,
    halted: false,
    globalHaltEnd: 0n,
    hookHaltEnd: 0n,
    lastSwapBlock: 100n,
    block: 105n,
    quote: 25_00000000n,
    quoteFailed: false,
    allowance: 10n ** 30n,
  }
}

let chain: Chain = openLadder()

const TIERS = [
  { price: 2_4950n, totalAmount: 3_150_000n * E18, soldAmount: 3_150_000n * E18 },
  { price: 2_5000n, totalAmount: 3_150_000n * E18, soldAmount: 2_850_000n * E18 },
  { price: 2_5050n, totalAmount: 3_150_000n * E18, soldAmount: 0n },
]

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER, isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useReadContract: ({ functionName }: { functionName: string }) => {
    const data: Record<string, unknown> = {
      tierStatus: chain.tierStatus,
      maxMintable: chain.maxMintable,
      lastSwapBlock: chain.lastSwapBlock,
      getTiers: TIERS,
      quoteMint: chain.quoteFailed ? undefined : chain.quote,
      allowance: chain.allowance,
    }
    return {
      data: data[functionName],
      isFetching: false,
      isError: functionName === 'quoteMint' && chain.quoteFailed,
      refetch: vi.fn(),
    }
  },
  useReadContracts: () => ({
    data: [
      { result: chain.halted },
      { result: chain.globalHaltEnd },
      { result: chain.hookHaltEnd },
    ],
  }),
  useBlockNumber: () => ({ data: chain.block }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  usePublicClient: () => ({ readContract: vi.fn() }),
}))

import { BondingStateProvider } from './bondingState'
import { BondingBuyPanel, BondingLadderSection } from './BondingPanel'

function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

function render(amount: string, over: { phase2Minted?: bigint; quoteBalance?: bigint } = {}) {
  const ui = mount(
    <BondingStateProvider
      hookAddress={HOOK}
      symbol="QMT"
      userAddress={USER}
      isConnected
      p0={2_0000n}
      shelfP0={2_1000n}
      currentPrice={2_5000n}
      phase2Minted={over.phase2Minted ?? 1_200_000n * E18}
      bondingMax={12_600_000n * E18}
      quoteBalance={over.quoteBalance ?? 1_000_00000000n}
      nowSec={NOW}
      refetch={() => {}}
    >
      <BondingLadderSection />
      <BondingBuyPanel />
    </BondingStateProvider>,
  )
  if (amount) ui.type(amount)
  return ui
}

beforeEach(() => { chain = openLadder() })

describe('Bonding · english copy golden master', () => {
  const cases: [string, string, (c: Chain) => void, { phase2Minted?: bigint; quoteBalance?: bigint }?][] = [
    ['no amount yet', '', () => {}],
    ['amount is not a number', '1..2', () => {}],
    ['halted platform-wide, average still settling', '1000', c => {
      c.halted = true; c.globalHaltEnd = BigInt(NOW + 3_725); c.tierStatus = [12n, 2_5000n, 300_000n * E18, 2_4000n, 0n, 2_1000n, true]
    }],
    ['halted for this project, past its stamp', '1000', c => {
      c.halted = true; c.hookHaltEnd = BigInt(NOW - 10)
    }],
    ['same-block lock', '1000', c => { c.lastSwapBlock = 105n }],
    ['more than one order can take', '90000', () => {}],
    ['before the first mint, waiting for the market', '1000', c => {
      c.tierStatus = [0n, 2_1000n, 3_150_000n * E18, 2_0000n, 2_0000n, 2_0000n, false]
    }, { phase2Minted: 0n }],
    ['above the price ceiling', '1000', c => {
      c.tierStatus = [12n, 2_5000n, 300_000n * E18, 2_3000n, 2_3000n, 2_4000n, false]
    }],
    ['no capacity at any size', '1000', c => { c.maxMintable = 0n }],
    ['quote still in flight', '1000', c => { c.quote = undefined }],
    ['quote reverted', '1000', c => { c.quoteFailed = true }],
    ['dust', '0.000001', c => { c.quote = 0n }],
    ['not enough balance', '1000', () => {}, { quoteBalance: 1_00000000n }],
    ['needs approval', '1000', c => { c.allowance = 0n }],
    ['ready to buy', '1000', () => {}],
  ]

  for (const [name, amount, setup, over] of cases) {
    it(name, () => {
      setup(chain)
      const ui = render(amount, over)
      try { pin(ui) } finally { ui.unmount() }
    })
  }
})
