// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { MAX_COOLDOWN_SECONDS } from '@/lib/contracts'

import { PogLimitPanel, CooldownDurationPanel } from './FactoryDials'

/**
 * The 500-unit ceiling is typed as plain digits rather than through its
 * `_LABEL` export, which carries thousands separators for the UI.
 *
 * It was `'1000000'` — the 1 M ETH ceiling from before the quote-asset
 * re-denomination. That is 50× the current bound, so the "arms exactly at the
 * ceiling" test began failing outright, while the "refuses one wei above" test
 * went on passing against a figure nowhere near the boundary it names. It was
 * then 20,000 BEM, until the WBNB cutover set it to 500.
 */
const MAX_POG_LIMIT_TYPED = '500'

/**
 * One base unit above the ceiling — 1e-8 here, where the test env's quote asset has 8 decimals.
 *
 * `parseUnits(x, 8)` does not reject extra decimal places, it truncates them, so
 * `500.000000000000000001` parses to exactly the ceiling and arms. A test asserting
 * a refusal one step above the bound therefore has to step by the quote asset's
 * actual smallest unit or it is asserting nothing.
 */
const ONE_UNIT_ABOVE_POG_LIMIT = '500.00000001'

/**
 * The bounded admin dials, tested through the affordance rather than the arithmetic.
 *
 * What is being pinned is not "the constant is 20,000" (the guard covers the
 * mirror and Foundry covers the bound) but the thing neither of those can see:
 * that a bad value reaches a disabled button carrying the reason, instead of an
 * armed button and a reverted owner transaction.
 *
 * The panels are driven through the real gate, the real `parseEthInput` and the
 * real `Button`; only wagmi is replaced, because the alternative is a live chain.
 */

// `contracts.ts` throws at import without a factory address, and `vi.stubEnv` in a
// `beforeEach` would run after the static imports above. Hoisting is the only
// place early enough; the file is `isolate: true`, so nothing leaks out of it.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * A connected owner on the right chain with no transaction in flight — the state
 * in which the domain blockers are the only thing that can still stop the button.
 * Get any of these wrong and every test passes for the wrong reason, because the
 * gate would be reporting `connect` or `switch` instead of the bound under test.
 */
vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: 0n, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  // `chainId` here, not on `useChainId`: the wrong-network gate reads the
  // connection, because the config's chain cannot report a chain the config
  // does not list. A mock without it is a wallet on no chain, which the gate
  // correctly refuses.
  useAccount: () => ({ isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}))

/**
 * Type a value, then report what the one action button says and whether it is armed.
 *
 * Insists on exactly one labelled button rather than picking the first: a helper
 * that quietly reads the wrong button is how a component test comes out green
 * while testing nothing.
 */
function verdictFor(panel: React.ReactElement, typed: string) {
  const ui = mount(panel)
  try {
    ui.type(typed)
    const labelled = ui.buttons().filter((b) => (b.textContent ?? '').trim() !== '')
    expect(labelled).toHaveLength(1)
    const btn = labelled[0]
    return {
      label: (btn.textContent ?? '').trim(),
      disabled: btn.disabled,
      reason: btn.getAttribute('title') ?? '',
      body: ui.text(),
    }
  } finally {
    ui.unmount()
  }
}

describe('POG ALLOCATION CEILING dial', () => {
  const READY = 'Update PoG ceiling'

  it('arms exactly at the ceiling', () => {
    const v = verdictFor(<PogLimitPanel />, MAX_POG_LIMIT_TYPED)
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('refuses one wei above the ceiling, naming the revert', () => {
    const v = verdictFor(<PogLimitPanel />, ONE_UNIT_ABOVE_POG_LIMIT)
    expect(v.label).toBe('[max_pog_limit_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('PogLimitTooHigh')
  })

  it('refuses the wei/ether slip: 0.1 ETH typed as its wei value', () => {
    const v = verdictFor(<PogLimitPanel />, '100000000000000000')
    expect(v.label).toBe('[max_pog_limit_violation]')
    expect(v.disabled).toBe(true)
  })

  it('still refuses zero, which the new ceiling must not have displaced', () => {
    // Both blockers live on this dial. Adding the upper one must not shadow the
    // lower one.
    const v = verdictFor(<PogLimitPanel />, '0')
    expect(v.label).toBe('[invalid_pog_limit]')
    expect(v.disabled).toBe(true)
  })

  it('arms at the 10-unit limit this repo\'s own fixtures use', () => {
    // Pinned by `test_setMaxPogAllocationLimit_admitsTheValuesThisSuiteUses`,
    // which sets `1000e16`: 10 whole units of the 18-decimal quote asset.
    const v = verdictFor(<PogLimitPanel />, '10')
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })
})

describe('RE-DEPOSIT COOLDOWN dial', () => {
  const READY = 'Set cooldown'

  it('arms exactly at MAX_COOLDOWN', () => {
    const v = verdictFor(<CooldownDurationPanel />, String(MAX_COOLDOWN_SECONDS))
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('refuses one second above MAX_COOLDOWN, naming the cap', () => {
    const v = verdictFor(<CooldownDurationPanel />, String(MAX_COOLDOWN_SECONDS + 1))
    expect(v.label).toBe('[above_max_cooldown]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('MAX_COOLDOWN')
  })

  it('refuses a duration that is not whole seconds', () => {
    const v = verdictFor(<CooldownDurationPanel />, '3600.5')
    expect(v.label).toBe('[not_whole_seconds]')
    expect(v.disabled).toBe(true)
  })
})
