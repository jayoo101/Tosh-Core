// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { bscTestnet } from 'wagmi/chains'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { mount, type Mounted } from '@/testing/renderClient'
import { RefundPanel } from './RefundPanel'
import { GenesisClaimPanel } from './GenesisClaimPanel'

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO PANELS THAT HAND MONEY BACK
// ─────────────────────────────────────────────────────────────────────────────
//
// Both are driven by ONE number — `hook.nativeDeposited(user)` — and both used
// to receive it through a `?? 0n` in `ProjectTerminal/index.tsx`. That made an
// unresolved read indistinguishable from "this wallet deposited nothing", which
// is the single worst place in the app for those two to be confused:
//
//   · `RefundPanel` gates its button on `=== 0n`, so a depositor arriving to
//     collect a failed round was told "This wallet has nothing deposited in this
//     project" while their own balance was still in flight. The phase is already
//     `refund` by then, so the round has failed and the window is finite.
//   · `GenesisClaimPanel` returns `null` on `=== 0n`, so the card for a real
//     genesis allocation was absent rather than merely blank.
//
// `GenesisClaimPanel` already had the right instinct for its OTHER input and
// said so in a comment — an unread `hasClaimed` must not hide the allocation.
// The deposit was the one value that skipped that rule.
//
// These tests exist because the failure is invisible on a fast RPC: it needs a
// slow or dropped multicall to show up at all, and it resolves itself moments
// later, so nobody watching a page ever catches it.

const USER = '0x35b232E26a275f62E594e010624aEA0c46b7874a' as const
const HOOK = '0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409' as const

// `hasClaimed` is the only read either panel makes on its own. Left `false` so
// the claim path is open and `nativeDeposited` is the sole variable under test.
vi.mock('wagmi', async importOriginal => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return {
    ...actual,
    useReadContract: () => ({ data: false, refetch: () => {} }),
  }
})

function wrap(node: React.ReactNode): Mounted {
  const config = createConfig({
    chains: [bscTestnet],
    transports: { [bscTestnet.id]: http('http://127.0.0.1:1') },
  })
  return mount(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
    </WagmiProvider>,
  )
}

let open: Mounted | undefined
afterEach(() => { open?.unmount(); open = undefined })

// ⚠ ASSERTED ON THE READOUT, NOT ON THE BLOCKER, and that is a limit of this
//   harness rather than a choice. With no wallet connected `useActionGate`
//   returns its `connect` verdict, which outranks every domain blocker, so the
//   button reads "Connect Wallet" and the `no-deposit` reason is not in the DOM
//   at all. A `not.toMatch(/nothing deposited/)` here would therefore pass
//   whatever the panel did — a vacuous test, and the first draft of this file
//   contained exactly that.
//
//   The readout is driven by the same value and IS rendered either way, so the
//   two directions below are a real contrast: `…` versus a stated `0`. Inverting
//   the fix turns both red.
describe('RefundPanel · a pending deposit is not an empty one', () => {
  it('shows a placeholder rather than a figure while the read is in flight', () => {
    open = wrap(
      <RefundPanel
        hookAddress={HOOK}
        nativeDeposited={undefined}
        refetch={() => {}}
        ladderViable={false}
      />,
    )

    expect(open.text()).toMatch(/Your deposit…/)
    expect(open.text()).not.toMatch(/Your deposit0/)
  })

  it('states the zero once it is real', () => {
    open = wrap(
      <RefundPanel
        hookAddress={HOOK}
        nativeDeposited={0n}
        refetch={() => {}}
        ladderViable={false}
      />,
    )

    expect(open.text()).toMatch(/Your deposit0/)
  })
})

describe('GenesisClaimPanel · a pending deposit does not remove the card', () => {
  it('renders while the deposit read is in flight', () => {
    open = wrap(
      <GenesisClaimPanel
        hookAddress={HOOK}
        symbol="TEST"
        userAddress={USER}
        nativeDeposited={undefined}
        refetch={() => {}}
      />,
    )

    // Present at all is the assertion. Under `?? 0n` this was the empty string.
    expect(open.text()).toMatch(/genesis allocation/i)
  })

  it('unmounts only on a confirmed zero', () => {
    open = wrap(
      <GenesisClaimPanel
        hookAddress={HOOK}
        symbol="TEST"
        userAddress={USER}
        nativeDeposited={0n}
        refetch={() => {}}
      />,
    )

    expect(open.text()).toBe('')
  })
})
