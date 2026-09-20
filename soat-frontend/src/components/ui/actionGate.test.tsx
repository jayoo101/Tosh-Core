// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { useActionGate } from './actionGate'

/**
 * The wrong-network verdict, tested against the chain the WALLET is on rather
 * than the one the config is pinned to.
 *
 * This gate read `useChainId()`, and that hook cannot answer the question it
 * was being asked. `useChainId` returns `config.state.chainId`, and
 * `createConfig`'s `syncConnectedChain` subscriber refuses to move it onto a
 * chain the config does not list — the comment in @wagmi/core reads "If chain
 * is not configured, then don't switch over to it". The config lists 97 and
 * 31337, so a wallet sitting on anything else leaves `useChainId()` reporting
 * 97: the gate compared 97 to 97, found nothing wrong, and handed a live
 * Deploy button to a wallet that could not sign for this chain. viem then
 * threw `ChainMismatchError` after the click, which is the latest possible
 * moment to discover it and the one place the user cannot act on it.
 *
 * `useAccount()` reads the connection instead — `getConnection` returns
 * `chainId: connection?.chainId` verbatim and only resolves `chain` against
 * the configured list — so it reports the wallet's real chain whether or not
 * this build knows about it. That is the reading the gate needs.
 *
 * The mocks below encode exactly that split. They are not free choices: a mock
 * where both hooks agree would pass against the broken gate too, and would
 * pin nothing.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/** What the wallet is actually on. Set per test. */
let walletChainId: number | undefined = 97

const switchChainAsync = vi.fn(async () => undefined)

vi.mock('wagmi', () => ({
  // Pinned to the first configured chain, as wagmi pins it. Never 4663.
  useChainId: () => 97,
  useAccount: () => ({ isConnected: walletChainId !== undefined, chainId: walletChainId }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync, isPending: false }),
}))

/** Mount the hook and hand back the verdict it settled on. */
function gateOn(chainId: number | undefined) {
  walletChainId = chainId
  let captured!: ReturnType<typeof useActionGate>['verdict']
  function Probe() {
    captured = useActionGate({ action: 'Deploy', onAct: () => {} }).verdict
    return null
  }
  const ui = mount(<Probe />)
  ui.unmount()
  return captured
}

describe('useActionGate — wrong network', () => {
  it('demands a switch when the wallet is on a chain this build does not configure', () => {
    const verdict = gateOn(4663)

    expect(verdict.kind).toBe('switch')
    expect(verdict.label).toMatch(/^Switch to /)
  })

  it('names the chain the wallet is on, not the one the config fell back to', () => {
    // The reason is the only place the user learns which chain they are on.
    // Reporting 97 here would tell a wallet on 4663 that it is already right.
    const verdict = gateOn(4663)

    expect(verdict.reason).toContain('This wallet is on chain 4663')
    expect(verdict.reason).not.toContain('This wallet is on chain 97')
    // The settlement half of the sentence still names the target.
    expect(verdict.reason).toContain('settles on chain 97')
  })

  it('is ready when the wallet is on the target chain', () => {
    const verdict = gateOn(97)

    expect(verdict.kind).toBe('ready')
    expect(verdict.label).toBe('Deploy')
  })
})
