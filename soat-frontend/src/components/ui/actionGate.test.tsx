// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http, useChainId } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { bscTestnet } from 'wagmi/chains'

// `contracts.ts` throws at import without a factory address, and the gate pulls
// `TARGET_CHAIN_ID` from it. Hoisting beats the static imports below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { mount } from '@/testing/renderClient'
import { useWalletChainId } from '@/lib/useWalletChainId'
import { useActionGate } from './actionGate'

/**
 * The wrong-network verdict, tested against REAL wagmi.
 *
 * ── Why this file was rewritten ─────────────────────────────────────────────
 *
 * The first version of this test mocked `wagmi` wholesale — it supplied its own
 * `useAccount` returning the wallet's chain and its own `useChainId` returning
 * the config's, then asserted the gate preferred the former. That tests the
 * mock. The claim the fix actually rests on is a claim ABOUT WAGMI: that these
 * two hooks disagree, and that only one of them can see a chain the config does
 * not list. A mock cannot support it, and would have gone on passing had wagmi
 * behaved the opposite way — which is the whole failure it was written to catch.
 *
 * So there is no `vi.mock('wagmi')` here. A fake EIP-1193 provider answers
 * `eth_chainId` with 4663 and the real `injected` connector, real
 * `createConfig` and real hooks do the rest.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * This gate read `useChainId()`, which returns `config.state.chainId`.
 * `createConfig`'s `syncConnectedChain` subscriber declines to move that value
 * onto a chain the config does not list — "If chain is not configured, then
 * don't switch over to it" — so a wallet on 4663 left it reporting 97, and
 * `chainId !== TARGET_CHAIN_ID` compared 97 to 97 and passed. The wallet got a
 * live Deploy button and viem's `ChainMismatchError` after the click, which is
 * the latest possible moment to learn it and the one place the user cannot act.
 *
 * `useAccount().chainId` reads the connection rather than the config, so it
 * reports the real chain whether or not this build configures it.
 * `useWalletChainId` wraps it, and the first test below is the one that pins
 * the difference rather than assuming it.
 */

// React 19 refuses to run `act` without this, and `renderClient` uses `act`.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WALLET_CHAIN = 4663
const ACCOUNT = '0x1111111111111111111111111111111111111111'

/** Minimal EIP-1193 provider that is parked on a chain wagmi knows nothing about. */
function fakeWallet() {
  return {
    on: () => {},
    removeListener: () => {},
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return `0x${WALLET_CHAIN.toString(16)}`
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ACCOUNT]
      throw new Error(`unstubbed ${method}`)
    },
  }
}

/**
 * `bscTestnet` and nothing else, matching `providers.tsx`. The transport points
 * at a dead port on purpose: the gate reads no contracts, and a reachable node
 * would only make the test slower and less deterministic.
 */
function makeConfig() {
  return createConfig({
    chains: [bscTestnet],
    connectors: [injected({ target: () => ({ id: 'fake', name: 'Fake', provider: fakeWallet() as never }) })],
    transports: { [bscTestnet.id]: http('http://127.0.0.1:1') },
  })
}

interface Reading {
  verdict: ReturnType<typeof useActionGate>['verdict']
  walletChainId: number | undefined
  configChainId: number
}

/**
 * Mount the gate under a real provider, connect the fake wallet, and hand back
 * what the hooks settled on.
 */
async function readGate(
  connectWallet: boolean,
  over: Partial<Parameters<typeof useActionGate>[0]> = {},
): Promise<Reading> {
  const config = makeConfig()
  const captured: Partial<Reading> = {}

  function Probe() {
    captured.verdict = useActionGate({ action: 'Deploy', onAct: () => {}, ...over }).verdict
    captured.walletChainId = useWalletChainId()
    captured.configChainId = useChainId()
    return null
  }

  const ui = mount(
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>
    </WagmiProvider>,
  )

  if (connectWallet) {
    // `connect` is reached through the config rather than `useConnect`, so the
    // test does not depend on the gate's own connect button to get set up.
    const { connect } = await import('wagmi/actions')
    await act(async () => { await connect(config, { connector: config.connectors[0] }) })
  }

  ui.unmount()
  return captured as Reading
}

describe('wagmi reports two different chains', () => {
  it('only useAccount() can see a chain the config does not list', async () => {
    const { walletChainId, configChainId } = await readGate(true)

    // The fact the fix depends on. If these two ever agree, the wrong-network
    // gate can go back to `useChainId` — and if `useAccount` ever starts
    // answering 97 here, `useWalletChainId` is no longer a fix and this fails.
    expect(walletChainId).toBe(WALLET_CHAIN)
    expect(configChainId).toBe(bscTestnet.id)
    expect(configChainId).not.toBe(WALLET_CHAIN)
  })
})

describe('useActionGate — wrong network', () => {
  it('demands a switch when the wallet is on a chain this build does not configure', async () => {
    const { verdict } = await readGate(true)

    expect(verdict.kind).toBe('switch')
    expect(verdict.label).toMatch(/^Switch to /)
  })

  it('names the chain the wallet is on, not the one the config fell back to', async () => {
    // The reason is the only place the user learns which chain they are on.
    // Reporting 97 here would tell a wallet on 4663 that it is already right.
    const { verdict } = await readGate(true)

    expect(verdict.reason).toContain(`This wallet is on chain ${WALLET_CHAIN}`)
    expect(verdict.reason).not.toContain(`This wallet is on chain ${bscTestnet.id}`)
    // The settlement half of the sentence still names the target.
    expect(verdict.reason).toContain(`settles on chain ${bscTestnet.id}`)
  })

  it('asks for a wallet before it asks about a network', async () => {
    const { verdict } = await readGate(false)

    expect(verdict.kind).toBe('connect')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ENGLISH GOLDEN MASTER
// ─────────────────────────────────────────────────────────────────────────────
//
// Taken before this gate's copy moves into a translation dictionary.
//
// ⚠ THIS GATE'S OWN STRINGS WERE THE ONE GAP IN THE TIER-0 COVERAGE, and the
//   reason is worth recording. The two panel golden masters both mock a wallet
//   that is CONNECTED AND ON THE RIGHT CHAIN, deliberately, because a domain
//   blocker cannot be rendered otherwise — `connect` and `switch` outrank every
//   one of them. So the four verdicts a user meets most often, on every panel in
//   the app, were pinned nowhere.
//
//   They are also the highest-leverage strings in the extraction: one swap here
//   is wrong on every action card at once, where a swap inside `RefundPanel` is
//   wrong on one.
//
// ⚠ RED DURING THE i18n WORK MEANS STOP, not `-u`.
//
// The whole verdict object is snapshotted rather than `strings()`, because this
// is a hook with no DOM of its own — and `tone` and `disabled` are worth pinning
// beside the copy anyway: they decide whether the button is clickable and what
// colour it is, and a wrong pairing there is the same class of error as a wrong
// sentence.
//
// NOT COVERED, and neither is reachable from this harness: the transient
// `Connecting…` / `Switching…` labels, which need a wallet prompt held open
// mid-flight, and the `chainId === undefined` arm of the switch reason, which
// needs a connected wallet that reports no chain — the fake provider always
// answers `eth_chainId`. `guard:i18n` still checks those three for placeholder
// drift in every locale; what is unpinned is only their English wording.
describe('english copy · golden master', () => {
  /** `reason` carries a `{chain}` the fixture controls, so it is safe to pin. */
  function shape(verdict: Reading['verdict']) {
    return {
      kind: verdict.kind,
      label: verdict.label,
      reason: verdict.reason,
      tone: verdict.tone,
      disabled: verdict.disabled,
    }
  }

  it('no wallet connected', async () => {
    const { verdict } = await readGate(false)
    expect(shape(verdict)).toMatchSnapshot()
  })

  it('connected, wrong chain', async () => {
    const { verdict } = await readGate(true)
    expect(shape(verdict)).toMatchSnapshot()
  })

  // `requiresNetwork: false` is how an off-chain action opts out of the switch
  // check, and here it is what lets the later verdicts be reached at all — the
  // fake wallet is parked on 4663 on purpose, so `switch` would otherwise win.
  it('awaiting signature', async () => {
    const { verdict } = await readGate(true, {
      requiresNetwork: false, tx: { isPending: true },
    })
    expect(shape(verdict)).toMatchSnapshot()
  })

  it('confirming', async () => {
    const { verdict } = await readGate(true, {
      requiresNetwork: false, tx: { isConfirming: true },
    })
    expect(shape(verdict)).toMatchSnapshot()
  })

  it('ready · the action label is the caller’s, not the gate’s', async () => {
    const { verdict } = await readGate(true, { requiresNetwork: false })
    expect(shape(verdict)).toMatchSnapshot()
  })

  // The blocker's own copy belongs to the surface that declared it, so this pins
  // only that the gate passes it through untouched.
  it('a domain blocker wins once the wallet and chain are settled', async () => {
    const { verdict } = await readGate(true, {
      requiresNetwork: false,
      blockersInRevertOrder: [{
        id: 'fixture',
        active: true,
        label: 'Fixture blocker',
        reason: 'A blocker supplied by the calling surface, passed through verbatim.',
        tone: 'warn',
      }],
    })
    expect(shape(verdict)).toMatchSnapshot()
  })
})
