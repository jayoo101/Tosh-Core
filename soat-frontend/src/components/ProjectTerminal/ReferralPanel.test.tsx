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
// action worth switching for, and a red assertion that the visitor's link "will
// not pay at all" drawn from a read that had not come back yet.
//
// Reads are stubbed BY FUNCTION NAME rather than by call order. They are
// independent `useReadContract` calls, so ordering them here would pin an
// implementation detail that is free to change.
//
// ⚠ `undefined` IS A DISTINCT ANSWER, which is what the `pogQuota: undefined`
//   case exists to hold. `0n` means "unattested, this link earns nothing"; an
//   unresolved read means "not known yet". The panel used to collapse the two
//   with `?? 0n`, so the loudest warning on the card was shown to every
//   attested wallet on first paint and then quietly withdrawn.

type Reads = {
  claimableReferral?: bigint
  referralAccrued?: bigint
  pogQuota?: bigint
  canBindProjectReferral?: boolean
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
  it('says nothing about the rate while the attestation read is in flight', () => {
    reads = { pogQuota: undefined, canBindProjectReferral: false }
    open = show('genesis')

    // The pessimistic strip is precisely what an unresolved read used to draw.
    expect(open.text()).not.toMatch(/pays nothing yet/i)
    expect(open.text()).not.toMatch(/pays the full/i)
    expect(open.buttons().map(b => b.textContent?.trim())).not.toContain('copy anyway')
  })

  it('leads with "pays nothing" for an unattested wallet, and hedges the copy verb', () => {
    reads = { pogQuota: 0n, canBindProjectReferral: false }
    open = show('genesis')

    expect(open.text()).toMatch(/pays nothing yet/i)
    expect(open.text()).toMatch(/Register PoG/i)
    // The link stays real and stays copyable — the verb only stops framing
    // handing out a dead link as the obvious next step.
    expect(open.button('copy anyway')).toBeTruthy()
  })

  it('says nothing about the rate while only the project leg is in flight', () => {
    // The sibling of the case above, and it survived the first repair because
    // `quotaKnown` was added to one read and not the other. With the quota
    // landed and `canBindProjectReferral` still pending, every attested sharer
    // was told the link pays 2% instead of 10% — then watched it change.
    reads = { pogQuota: 1n, canBindProjectReferral: undefined }
    open = show('genesis')

    expect(open.text()).not.toMatch(/pays 2%, not 10%/i)
    expect(open.text()).not.toMatch(/pays the full/i)
    expect(open.text()).not.toMatch(/pays nothing yet/i)
  })

  it('separates the 2%-only case from the dead one', () => {
    reads = { pogQuota: 1n, canBindProjectReferral: false }
    open = show('genesis')

    expect(open.text()).not.toMatch(/pays nothing yet/i)
    expect(open.text()).toMatch(/pays 2%, not 10%/i)
    expect(open.text()).toMatch(/Deposit first/i)
  })

  it('confirms the full rate when both legs bind, with no fix to offer', () => {
    reads = { pogQuota: 1n, canBindProjectReferral: true }
    open = show('genesis')

    expect(open.text()).toMatch(/pays the full 10%/i)
    expect(open.button('copy')).toBeTruthy()
  })
})

describe('ReferralPanel · the claim block earns its space', () => {
  it('is absent during genesis when nothing has accrued', () => {
    reads = {
      pogQuota: 1n, canBindProjectReferral: true,
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
      pogQuota: 1n, canBindProjectReferral: true,
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
      pogQuota: 1n, canBindProjectReferral: true,
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
      pogQuota: 1n, canBindProjectReferral: true,
      claimableReferral: undefined, referralAccrued: undefined,
    }
    open = show('bonding')

    expect(open.text()).toMatch(/referral/i)
  })
})
