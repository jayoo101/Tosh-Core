// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { bscTestnet } from 'wagmi/chains'

// `contracts.ts` throws at import without a factory address, and this panel
// pulls the referral rates from it. Hoisting beats the static imports below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { mount } from '@/testing/renderClient'
import { ReferralPanel } from './ReferralPanel'

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL DESK
// ─────────────────────────────────────────────────────────────────────────────
//
// The panel only renders with a wallet connected, so none of it can be checked
// by loading a page — which is how it came to carry a claim readout that could
// only ever say "0", a full-width "switch network" button on a card offering no
// action worth switching for.
//
// Reads are stubbed BY FUNCTION NAME rather than by call order. They are
// independent `useReadContract` calls, so ordering them here would pin an
// implementation detail that is free to change.

type Reads = {
  claimableReferral?: bigint
  referralAccrued?: bigint
}

let reads: Reads = {}

vi.mock('wagmi', async importOriginal => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return {
    ...actual,
    useReadContract: ({ functionName }: { functionName: keyof Reads }) => ({
      data: reads[functionName],
      refetch: () => {},
    }),
  }
})

const USER = '0x35b232E26a275f62E594e010624aEA0c46b7874a' as const
const HOOK = '0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409' as const

function show(phase: 'genesis' | 'bonding') {
  const config = createConfig({
    chains: [bscTestnet],
    transports: { [bscTestnet.id]: http('http://127.0.0.1:1') },
  })
  return mount(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={new QueryClient()}>
        <ReferralPanel
          hookAddress={HOOK}
          symbol="TEST"
          userAddress={USER}
          refetch={() => {}}
          phase={phase}
        />
      </QueryClientProvider>
    </WagmiProvider>,
  )
}

let open: ReturnType<typeof show> | null = null

beforeEach(() => {
  reads = {}
  // `useReferralCode` POSTs for a short code. Refusing it exercises the long
  // `?ref=<address>` fallback, the link every wallet has from the start.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
})

afterEach(() => {
  open?.unmount()
  open = null
  vi.unstubAllGlobals()
})

describe('ReferralPanel · what the link is worth, said first', () => {
  it('always states the full rate: any wallet can promote', () => {
    open = show('genesis')

    expect(open.text()).toMatch(/pays the full 10%/i)
    expect(open.text()).toMatch(/no deposit or PoG needed/i)
    expect(open.button('copy')).toBeTruthy()
  })
})

describe('ReferralPanel · the claim block earns its space', () => {
  it('is absent during genesis when nothing has accrued', () => {
    reads = {
      claimableReferral: 0n, referralAccrued: 0n,
    }
    open = show('genesis')

    expect(open.text()).not.toMatch(/CLAIMABLE COMMISSION/i)
    // Because the gate ranks the network blocker first, rendering the claim
    // action here also put a full-width "switch network" button on a card with
    // nothing behind it.
    const labels = open.buttons().map(b => (b.textContent ?? '').trim())
    expect(labels).toEqual(['copy'])
    // The link, which is the card's whole job during genesis, survives.
    expect(open.text()).toContain(USER)
  })

  it('appears as soon as the link has earned, before launch unlocks it', () => {
    reads = {
      claimableReferral: 0n, referralAccrued: 5n * 10n ** 17n,
    }
    open = show('genesis')

    expect(open.text()).toMatch(/CLAIMABLE COMMISSION/i)
    // Earned is shown beside the locked zero, so a mid-raise sharer is not told
    // they have nothing when they have something they cannot withdraw yet.
    expect(open.text()).toMatch(/earned · unlocks at launch\(\)/i)
  })

  it('still draws after genesis when there is money to collect', () => {
    reads = {
      claimableReferral: 10n ** 18n, referralAccrued: 10n ** 18n,
    }
    open = show('bonding')

    expect(open.text()).toMatch(/CLAIMABLE COMMISSION/i)
  })

  it('does not unmount the whole card while the claimable read is in flight', () => {
    // The sharpest version of the `?? 0n` fault in this file: after genesis the
    // panel returns `null` when there is nothing to collect, and an unresolved
    // read coalesced to `0n` satisfied that test. So a launched project that
    // owed this wallet commission showed no claim button on its own page, and
    // /referrals became the only route to the money — which is the outcome the
    // early return's own comment says it exists to prevent.
    reads = {
      claimableReferral: undefined, referralAccrued: undefined,
    }
    open = show('bonding')

    expect(open.text()).toMatch(/referral/i)
  })
})
