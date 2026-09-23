// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

import { GenesisPanel, type GenesisProps } from './GenesisPanel'
import { QuotaLedger } from './QuotaLedger'

/**
 * What the deposit panel is allowed to ASK FOR, given what it already knows.
 *
 * Every assertion here is about one sentence appearing next to another sentence
 * that contradicts it. That sounds like a styling concern and it is not: the
 * contradiction below took the raise funnel down for 26 minutes.
 *
 * A wallet three thousand times under the gas floor was shown a greyed-out
 * amount field, the hint `46.4 TQUOTE LEFT FOR YOU`, a quota ledger whose
 * footer read `→ WITHIN YOUR LIMIT`, and a button reading `Enter an amount` —
 * four surfaces agreeing the only missing thing was a number, beside one
 * callout stating the truth. Readers resolved it the way anyone resolves a
 * contradiction between a form that wants input and a notice that says no:
 * they retried. Repeated gas scans exhausted the shared Proof-of-Gas credit
 * budget, `/api/pog-scan` began answering `503 at capacity`, and nobody could
 * deposit.
 *
 * So the thing under test is not copy. It is that the panel never solicits an
 * action it has already refused. `toContain` on the rendered text is the right
 * instrument for exactly that, because the contradiction was only ever visible
 * as two strings on one screen.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOOK = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

/** Set per test, and read through the mocked provider below. */
let pog: ReturnType<typeof pogFlow>

vi.mock('./PogLookupProvider', () => ({ usePogLookup: () => pog }))

/*
 * Partial, because `DepositSuccessDialog` mounts CLOSED rather than not at all,
 * so its `useReferralLink` chain runs on every render and reaches three more
 * exports of this module. Replacing the whole module means discovering those one
 * failure at a time and re-discovering them whenever the chain grows; keeping
 * the original and overriding the two hooks that would talk to the network is
 * both shorter and stable under that change.
 */
vi.mock('@/lib/useReferral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/useReferral')>()),
  resolveReferrerNow: () => ZERO,
  useReferralCode: () => ({ code: null, state: 'none' as const }),
}))

vi.mock('wagmi', () => ({
  // `chainId` on the account, not on `useChainId`: `useWalletChainId` reads the
  // connection, and a mock without it is a wallet on no chain, which the
  // wrong-network gate correctly refuses — every assertion would then pass
  // because the button said `Switch network`.
  useAccount: () => ({
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    isConnected: true,
    chainId: 97,
  }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  // A generous standing allowance, so `approve` is never the blocker on test.
  useReadContract: () => ({ data: 2n ** 200n, refetch: vi.fn() }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  usePublicClient: () => ({ readContract: vi.fn() }),
}))

/**
 * Stable identities on every callback.
 *
 * Not cosmetic: `bindRefetch` and `startLookup` are effect dependencies in the
 * panel, so a fresh `vi.fn()` per render would re-run those effects forever and
 * the test would hang rather than fail.
 */
const stable = {
  setDialogOpen: vi.fn(),
  startLookup: vi.fn(async () => {}),
  registerQuota: vi.fn(async () => {}),
  bindRefetch: vi.fn(),
}

function pogFlow(over: Partial<{
  phase: string
  scan: { eligible: boolean; totalGasWei: string; floorWei: string; truncated: boolean } | undefined
}> = {}) {
  return {
    userAddress: USER,
    phase: 'idle',
    scan: undefined,
    error: null,
    dialogOpen: false,
    registering: false,
    isPending: false,
    isConfirming: false,
    ...stable,
    ...over,
  }
}

const NOW = 1_700_000_000

/**
 * 8 decimals, because that is what the quote asset has — and writing the
 * per-wallet cap as `46_40000000n` rather than `parseUnits` keeps the figure in
 * the screenshot this was diagnosed from legible in the source.
 */
const BASE: GenesisProps = {
  hookAddress: HOOK,
  symbol: 'QMT',
  userAddress: USER,
  isConnected: true,
  totalNativeDeposited: 0n,
  quoteBalance: 298_69280000n,
  pogQuota: 0n,
  quotaRemaining: 0n,
  blacklistedUntil: 0n,
  cooldownEnd: 0n,
  nowSec: NOW,
  perWalletCap: 46_40000000n,
  userDeposited: 0n,
  genesisDeadline: BigInt(NOW + 86_400),
  referrer: ZERO,
  refetch: () => {},
}

/** An attested wallet with a full window, i.e. one that really may deposit. */
const ATTESTED = { pogQuota: 46_40000000n, quotaRemaining: 46_40000000n } as const

/** The wallet from the screenshot: 7.62e-6 ETH of gas against a 0.025 floor. */
const REFUSED = {
  eligible: false,
  totalGasWei: '7620000000000',
  floorWei: '25000000000000000',
  truncated: false,
} as const

/** `mount` renders inside `act`, so effects — `useIsHydrated` included — have run. */
function render(over: Partial<GenesisProps> = {}) {
  return mount(<GenesisPanel {...BASE} {...over} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  pog = pogFlow()
})

describe('a wallet the gas floor has refused', () => {
  beforeEach(() => { pog = pogFlow({ phase: 'ready', scan: REFUSED }) })

  it('is given no deposit form at all', () => {
    const ui = render()
    try {
      // The strongest available statement of the fix: there is nothing to type
      // into, so there is nothing for a "just enter a number" reading to latch
      // onto. A disabled input would still satisfy a copy assertion.
      expect(ui.container.querySelectorAll('input')).toHaveLength(0)
      expect(ui.text()).toContain('This wallet cannot deposit')
      expect(ui.text()).toContain('BELOW THE GAS FLOOR')
    } finally { ui.unmount() }
  })

  it('states the gap as a multiple, so a structural miss cannot read as a near one', () => {
    const ui = render()
    try {
      // 0.025 / 7.62e-6. The two absolute figures differ by three orders of
      // magnitude and look adjacent in a column; this is the number that does
      // not.
      expect(ui.text()).toContain('3,281×')
    } finally { ui.unmount() }
  })

  it('never solicits an amount, a limit or a retry', () => {
    const ui = render()
    try {
      const text = ui.text()
      expect(text).not.toContain('Enter an amount')
      expect(text).not.toContain('LEFT FOR YOU')
      expect(text).not.toContain('WITHIN YOUR LIMIT')
      // ⚠ A retry button here would rebuild the exact loop that exhausted the
      //   budget: a scan cannot change an answer measured from gas already
      //   spent. Switching wallets is what changes it, and that rescans by
      //   itself.
      expect(ui.buttons().map((b) => b.textContent ?? '')).not.toContain('Retry gas check')
      expect(text).not.toMatch(/try again/i)
    } finally { ui.unmount() }
  })

  it('yields to a closed window, which refuses everyone and is the nearer fact', () => {
    // Taking the panel over to discuss this wallet's gas would answer a question
    // about the PROJECT by talking only about the reader, and leave "the raise is
    // over" to be inferred from an absent button.
    const ui = render({ genesisDeadline: BigInt(NOW - 10) })
    try {
      expect(ui.text()).toContain('WINDOW CLOSED')
      expect(ui.text()).toContain('Funding closed')
      expect(ui.text()).not.toContain('This wallet cannot deposit')
      // Still no personal offer, though: the ordinary panel has to stay honest.
      expect(ui.text()).not.toContain('LEFT FOR YOU')
    } finally { ui.unmount() }
  })
})

describe('blocker order · the button never asks for what the field refuses', () => {
  /**
   * Each case below disables the amount field. Before the reorder every one of
   * them rendered `Enter an amount`, because the amount nags headed the revert
   * order and `useActionGate` takes the FIRST active blocker — so the button
   * asked for input into an input it had locked.
   */
  it('names the missing attestation, not the empty field', () => {
    const ui = render()
    try {
      expect(ui.text()).toContain('Check gas history')
      expect(ui.text()).not.toContain('Enter an amount')
    } finally { ui.unmount() }
  })

  it('names the closed window, not the empty field', () => {
    const ui = render({ ...ATTESTED, genesisDeadline: BigInt(NOW - 10) })
    try {
      expect(ui.text()).toContain('Funding closed')
      expect(ui.text()).not.toContain('Enter an amount')
    } finally { ui.unmount() }
  })

  it('names the ban, not the empty field', () => {
    const ui = render({ ...ATTESTED, blacklistedUntil: BigInt(NOW + 3600) })
    try {
      expect(ui.text()).toContain('Wallet blocked')
      expect(ui.text()).not.toContain('Enter an amount')
    } finally { ui.unmount() }
  })

  it('names the cooldown, not the empty field', () => {
    const ui = render({ ...ATTESTED, cooldownEnd: BigInt(NOW + 3600) })
    try {
      expect(ui.text()).toContain('Cooldown')
      expect(ui.text()).not.toContain('Enter an amount')
    } finally { ui.unmount() }
  })

  it('still asks for an amount when that is genuinely the only thing missing', () => {
    // The reorder has to leave the normal resting state alone. Without this the
    // suite would pass just as well if the amount blockers had been deleted.
    const ui = render(ATTESTED)
    try {
      expect(ui.text()).toContain('Enter an amount')
      expect(ui.text()).toContain('LEFT FOR YOU')
    } finally { ui.unmount() }
  })
})

describe('the per-wallet headroom hint', () => {
  it('drops the personal claim for a wallet that cannot deposit', () => {
    const ui = render()
    try {
      // The project's ceiling is a fact about the project and survives; "left
      // FOR YOU" is a promise about the reader and must not be made to a wallet
      // the same panel is refusing.
      expect(ui.text()).toContain('PER WALLET')
      expect(ui.text()).not.toContain('LEFT FOR YOU')
    } finally { ui.unmount() }
  })
})

describe('QuotaLedger · an unreadable ledger is not a clean one', () => {
  /**
   * `breached` is forced false whenever `blocked` is set, and the footer was the
   * `else` of a two-way branch on it. So the panel's most reassuring sentence
   * was reserved for precisely the case where every figure above it was an
   * em-dash.
   */
  for (const blocked of ['unattested', 'banned', 'cooldown'] as const) {
    it(`does not report "within your limit" when ${blocked}`, () => {
      const ui = mount(
        <QuotaLedger quota={0n} remaining={0n} projected={0n} blocked={blocked} />,
      )
      try {
        expect(ui.text()).not.toContain('WITHIN YOUR LIMIT')
      } finally { ui.unmount() }
    })
  }

  it('still reports it when the figures are real and the amount fits', () => {
    const ui = mount(
      <QuotaLedger quota={100n} remaining={60n} projected={10n} blocked={null} />,
    )
    try {
      expect(ui.text()).toContain('WITHIN YOUR LIMIT')
    } finally { ui.unmount() }
  })
})
