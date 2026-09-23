// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'

import { RefundPanel } from './RefundPanel'
import { GenesisClaimPanel } from './GenesisClaimPanel'
import { AwaitingLaunchPanel } from './AwaitingLaunchPanel'
import { GenesisIneligible } from './GenesisIneligible'

/**
 * ENGLISH GOLDEN MASTER · the three surfaces that hand money back, plus the one
 * that refuses a wallet outright.
 *
 * Taken BEFORE any string here moves into a translation dictionary. Its only
 * job is to stay unchanged while ~120 of them do.
 *
 * ? WHY A SNAPSHOT AND NOT MORE `toContain`. The extraction is mechanical, and
 *   its worst failure is a swap rather than a loss: hand two blockers each
 *   other's `reason` and the panel states the wrong cause for refusing to pay a
 *   depositor. Single-string assertions cannot see that ? both strings are still
 *   on the page ? and neither can `tsc`, eslint or a screenshot. `strings()` is
 *   ordered, so a swap moves two entries and this goes red.
 *
 * ? RED DURING THE i18n WORK MEANS STOP, not `-u`. The extraction is not allowed
 *   to change a single word a user reads; that is the entire premise that makes
 *   it safe to do across sixty files. Outside that work, a deliberate rewording
 *   updates the snapshot in the commit that argues for it.
 *
 * ?? Why this file exists next to `refundReads.test.tsx` rather than inside it ??
 *
 * That file mounts these panels with NO WALLET CONNECTED, deliberately, and its
 * own header explains the consequence: `useActionGate` returns its `connect`
 * verdict, which outranks every domain blocker, so the button reads
 * "Connect Wallet" and no blocker reason reaches the DOM. Its assertions are on
 * the readout for exactly that reason.
 *
 * A golden master needs the opposite ? the blocker copy is the most dangerous
 * copy on these surfaces, so it has to be rendered. Rather than add a connected
 * account to that file and quietly invalidate the premise its comments argue
 * for, the wallet lives here.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOOK = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address

/**
 * A connected wallet on the right chain, so the gate falls through to the
 * domain blockers instead of stopping at `connect` or `switch network`.
 *
 * `chainId` sits on the account rather than on `useChainId` because
 * `useWalletChainId` reads the connection ? a mock without it is a wallet on no
 * chain, which the wrong-network gate correctly refuses, and every snapshot
 * below would record "Switch network" instead of the copy under test.
 *
 * `useReadContract` answers `false`, which is `hasClaimed` for
 * `GenesisClaimPanel` ? the only read either of these panels makes on its own.
 * False leaves the claim path open so the deposit is the sole variable.
 */
vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    isConnected: true,
    chainId: 97,
  }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useReadContract: () => ({ data: false, refetch: vi.fn() }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  usePublicClient: () => ({ readContract: vi.fn() }),
}))

const NOW = 1_700_000_000
const noop = () => {}

/**
 * Both halves of the net, on every state below.
 *
 * `strings()` is ordered and node-sensitive, which is what catches a swap. That
 * same sensitivity makes it go red on a change that merges text nodes without
 * touching a word ? and merging nodes is exactly what extracting copy does here,
 * because half the sentences on these panels are split mid-way by an
 * interpolated ticker or figure. One of them is visible in the snapshots below
 * as `"?funding it with" / "TQUOTE" / ". The quota comes from?"`. A dictionary
 * stores that as one sentence with a `{symbol}` placeholder, because a translator
 * handed three fragments cannot reorder them, and Chinese needs a different
 * order.
 *
 * `prose()` is the assertion that has to stay green through that. Identical
 * collapsed text content means identical characters in identical order, so a
 * reworded or dropped sentence still fails it ? only the node boundaries are
 * free to move.
 *
 * ? ORDER MATTERS. `strings()` stays the first call so it keeps the snapshot key
 *   it already had; putting `prose()` ahead of it would renumber every baseline
 *   taken before the extraction and discard the thing being compared against.
 *
 * ? AND `soft`, SO THE SECOND ONE STILL RUNS. A hard failure on `strings()` ends
 *   the test, `prose()` never evaluates, and Vitest reports it as an obsolete
 *   snapshot ? at the one moment its answer matters most. Together they are a
 *   diagnosis rather than an alarm: `strings()` red with `prose()` green says the
 *   text nodes moved; both red says the words did.
 */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('RefundPanel · english copy golden master', () => {
  /*
   * `ladderViable` picks between the two refund reasons, and the pair is the
   * reason this panel has a `refundReason` function at all: the subtitle used to
   * state the zombie case as fact, which was shown up to a week early to
   * creators who had not run out of time and never would. Both arms are pinned.
   *
   * `nativeDeposited` then picks the blocker: `undefined` is a read in flight,
   * `0n` is a definite nothing, and a real figure arms the button. The first two
   * are separate states on purpose ? collapsing them told a depositor arriving
   * to collect a failed round that they had nothing here.
   */
  for (const [name, props] of [
    ['too small to open a pool · deposit in flight', { ladderViable: false, nativeDeposited: undefined }],
    ['too small to open a pool · nothing deposited', { ladderViable: false, nativeDeposited: 0n }],
    ['too small to open a pool · refund armed',      { ladderViable: false, nativeDeposited: 250_00000000n }],
    ['launch window lapsed · refund armed',          { ladderViable: true,  nativeDeposited: 250_00000000n }],
  ] as const) {
    it(name, () => {
      const ui = mount(
        <RefundPanel
          hookAddress={HOOK}
          nativeDeposited={props.nativeDeposited}
          refetch={noop}
          ladderViable={props.ladderViable}
        />,
      )
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})

describe('GenesisClaimPanel · english copy golden master', () => {
  // `0n` unmounts the card entirely, which `refundReads.test.tsx` already pins
  // as a behaviour. There is no copy in that state, so it is not a golden case.
  for (const [name, nativeDeposited] of [
    ['deposit in flight', undefined],
    ['allocation to claim', 250_00000000n],
  ] as const) {
    it(name, () => {
      const ui = mount(
        <GenesisClaimPanel
          hookAddress={HOOK}
          symbol="QMT"
          userAddress={USER}
          nativeDeposited={nativeDeposited}
          refetch={noop}
        />,
      )
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})

describe('AwaitingLaunchPanel · english copy golden master', () => {
  // The creator sees a button and an argument for pressing it; everyone else
  // sees the same wait with none of the agency. Both are user-facing.
  for (const [name, isCreator] of [
    ['as the creator', true],
    ['as a depositor', false],
  ] as const) {
    it(name, () => {
      const ui = mount(
        <AwaitingLaunchPanel
          hookAddress={HOOK}
          symbol="QMT"
          isCreator={isCreator}
          totalNativeDeposited={40_95970000n}
          genesisDeadline={BigInt(NOW - 3600)}
          nowSec={NOW}
          refetch={noop}
        />,
      )
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})

describe('GenesisIneligible · english copy golden master', () => {
  /*
   * The gap is rendered as a multiple, and the two branches of that formatting
   * are separate states: under 100× keeps one decimal, at or above it rounds and
   * groups. A translation that moves the `×` or the grouping would change a
   * figure whose whole purpose is to read as structural rather than near.
   */
  for (const [name, totalGasWei] of [
    ['three thousand times under · the figure from the outage', '7620000000000'],
    ['just under · one decimal survives',                       '500000000000000'],
  ] as const) {
    it(name, () => {
      const ui = mount(
        <GenesisIneligible
          totalGasWei={BigInt(totalGasWei)}
          floorWei={25_000_000_000_000_000n}
          onOpenBreakdown={noop}
        />,
      )
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})
