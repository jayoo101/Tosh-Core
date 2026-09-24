// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
  process.env.NEXT_PUBLIC_QUOTE_ASSET = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
})

/**
 * ENGLISH GOLDEN MASTER · the liquidity panel.
 *
 * Taken before its copy moves into the dictionary. Five approval steps and
 * nine refusals share one button, and each is a label plus a reason; two of
 * them trading places would name the wrong next signature — which, on a panel
 * whose whole job is sequencing five signatures, is the failure that matters.
 * Every blocker is rendered on its own below, in revert order.
 *
 * The chain is faked at the wagmi boundary: `balanceOf` answers the token
 * balance, and `allowance` answers by contract — the ERC-20 allowance to
 * Permit2 on the token or the quote asset, or Permit2's own
 * `[amount, expiration, nonce]` for either.
 */

const USER  = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOOK  = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const TOKEN = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const NOW   = 1_700_000_000
const E18   = 10n ** 18n
const Q96   = 1n << 96n
const MAX   = (1n << 160n) - 1n
const LATER = NOW + 86_400 * 30

interface Chain {
  tokenBalance:    bigint | undefined
  tokenToPermit2:  bigint
  permit2Token:    readonly [bigint, number, number]
  quoteToPermit2:  bigint
  permit2Quote:    readonly [bigint, number, number]
}

function funded(): Chain {
  return {
    tokenBalance:   1_000_000n * E18,
    tokenToPermit2: MAX,
    permit2Token:   [MAX, LATER, 0],
    quoteToPermit2: MAX,
    permit2Quote:   [MAX, LATER, 0],
  }
}

let chain: Chain = funded()

interface Pool { sqrtPriceX96: bigint; bitmap: number | undefined }
let pool: Pool = { sqrtPriceX96: Q96, bitmap: 0x0fff }

interface Positions {
  positions: { tokenId: bigint; amount0: bigint; amount1: bigint }[]
  degraded: boolean
}
let lp: Positions = { positions: [], degraded: false }

// BSC testnet declares no block time, so the real function answers
// `undefined` here and the coverage note never renders. Mainnet reads about ten
// days, and that is the build real users see, so the note is pinned by
// overriding the answer.
let coverage: { n: number; unit: 'hours' | 'days' } | undefined

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER, isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useReadContract: ({ address, functionName, args }: {
    address?: string; functionName: string; args?: readonly unknown[]
  }) => {
    // A read whose inputs are not ready is disabled, and wagmi answers it with
    // no data at all.
    if (!address || !args) return { data: undefined, isFetching: false, isError: false, refetch: vi.fn() }
    let data: unknown
    if (functionName === 'balanceOf') data = chain.tokenBalance
    if (functionName === 'allowance') {
      const token = args?.length === 3 ? String(args[1]) : String(address)
      const isQuote = token.toLowerCase() === process.env.NEXT_PUBLIC_QUOTE_ASSET!.toLowerCase()
      if (args?.length === 3) data = isQuote ? chain.permit2Quote : chain.permit2Token
      else data = isQuote ? chain.quoteToPermit2 : chain.tokenToPermit2
    }
    return { data, isFetching: false, isError: false, refetch: vi.fn() }
  },
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  usePublicClient: () => ({ readContract: vi.fn() }),
}))

vi.mock('@/lib/useLpPosition', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/useLpPosition')>()
  return {
    ...real,
    lpScanCoverage: () => coverage,
    useLpPoolState: () => ({
      sqrtPriceX96: pool.sqrtPriceX96,
      totalLiquidity: 5_000_000n * E18,
      hooksRegistrationBitmap: pool.bitmap,
    }),
    useLpPositions: () => ({
      positions: lp.positions,
      totals: lp.positions.reduce(
        (t, p) => ({ amount0: t.amount0 + p.amount0, amount1: t.amount1 + p.amount1 }),
        { amount0: 0n, amount1: 0n },
      ),
      degraded: lp.degraded,
      refresh: vi.fn(),
    }),
  }
})

import { LiquidityPanel } from './LiquidityPanel'

function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

function render(amount: string, over: {
  tokenAddress?: Address | undefined; quoteBalance?: bigint; nowSec?: number
} = {}) {
  const ui = mount(
    <LiquidityPanel
      hookAddress={HOOK}
      tokenAddress={'tokenAddress' in over ? over.tokenAddress : TOKEN}
      symbol="QMT"
      userAddress={USER}
      isConnected
      quoteBalance={over.quoteBalance ?? 1_000_00000000n}
      nowSec={over.nowSec ?? NOW}
    />,
  )
  if (amount) ui.type(amount)
  return ui
}

const ONE = { tokenId: 42n, amount0: 12_50000000n, amount1: 12n * E18 }
const TWO = { tokenId: 43n, amount0: 3_00000000n, amount1: 3n * E18 }

beforeEach(() => {
  chain = funded()
  pool = { sqrtPriceX96: Q96, bitmap: 0x0fff }
  lp = { positions: [], degraded: false }
  coverage = undefined
})

type Over = Parameters<typeof render>[1]
type Case = [string, string, () => void, Over?]

describe('Liquidity · english copy golden master', () => {
  const cases: Case[] = [
    ['no amount yet, no positions', '', () => {}],
    ['one open position, scan complete', '', () => { lp.positions = [ONE] }],
    ['scan covers days, as on mainnet', '', () => { coverage = { n: 10, unit: 'days' } }],
    ['scan covers hours', '', () => { lp.positions = [ONE]; coverage = { n: 36, unit: 'hours' } }],
    ['two open positions, logs unavailable', '', () => { lp = { positions: [ONE, TWO], degraded: true } }],
    ['clock not yet synced', '10', () => {}, { nowSec: 0 }],
    ['token address still loading', '10', () => {}, { tokenAddress: undefined }],
    ['amount is not a number', '1..2', () => {}],
    ['pool price unavailable', '10', () => { pool.sqrtPriceX96 = 0n }],
    ['pool key bitmap unresolved', '10', () => { pool.bitmap = undefined }],
    ['wallet reads in flight', '10', () => { chain.tokenBalance = undefined }],
    ['not enough of the quote asset', '10', () => {}, { quoteBalance: 1_00000000n }],
    ['not enough of the token', '10', () => { chain.tokenBalance = 1n }],
    ['too small to mint liquidity', '0.00000001', () => { pool.sqrtPriceX96 = 1n << 48n }],
    ['step 1 · approve the token for Permit2', '10', () => { chain.tokenToPermit2 = 0n }],
    ['step 2 · let Permit2 spend the token', '10', () => { chain.permit2Token = [0n, 0, 0] }],
    ['step 3 · approve the quote asset for Permit2', '10', () => { chain.quoteToPermit2 = 0n }],
    ['step 4 · let Permit2 spend the quote asset', '10', () => { chain.permit2Quote = [MAX, NOW, 0] }],
    ['ready to deposit', '10', () => {}],
  ]

  for (const [name, amount, setup, over] of cases) {
    it(name, () => {
      setup()
      const ui = render(amount, over)
      try { pin(ui) } finally { ui.unmount() }
    })
  }
})
