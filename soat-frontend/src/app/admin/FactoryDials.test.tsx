// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import {
  MAX_LAUNCH_FEE_LABEL,
  MIN_SOFT_CAP_PROD_LABEL,
  MAX_COOLDOWN_SECONDS,
} from '@/lib/contracts'

import { LaunchFeePanel, SoftCapPanel, CooldownDurationPanel } from './FactoryDials'

/**
 * The bounded admin dials, tested through the affordance rather than the arithmetic.
 *
 * Each of these three panels refuses a value the factory would revert on, and
 * until now none of them had a test 鈥?SECURITY_AUDIT.md 搂5.14 recorded exactly
 * that, and the reason it was recorded rather than fixed is that the suite had no
 * way to render a component at all.
 *
 * What is being pinned is not "the constant is 10 ether" (the guard covers the
 * mirror and Foundry covers the bound) but the thing neither of those can see:
 * that a bad value reaches a disabled button carrying the reason, instead of an
 * armed button and a reverted owner transaction. `MAX_LAUNCH_FEE` exists to catch
 * a wei/ether slip in a transaction builder, and this is the field where that
 * slip gets typed.
 *
 * The panels are driven through the real gate, the real `parseEthInput` and the
 * real `Button`; only wagmi is replaced, because the alternative is a live chain.
 */

// `contracts.ts` throws at import without a factory address, and `vi.stubEnv` in a
// `beforeEach` would run after the static imports above. Hoisting is the only
// place early enough; the file is `isolate: true`, so nothing leaks out of it.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '46630'
})

/**
 * A connected owner on the right chain with no transaction in flight 鈥?the state
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
  useAccount: () => ({ isConnected: true }),
  useChainId: () => 46630,
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

describe('LAUNCH FEE dial', () => {
  const READY = 'Update launch fee'

  it('arms at the ceiling, because the on-chain bound is inclusive', () => {
    // `test_setLaunchFee_atBoundary` pins the same value on the contract. If the
    // UI refused it the two would disagree about what is legal.
    const v = verdictFor(<LaunchFeePanel />, MAX_LAUNCH_FEE_LABEL)
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('refuses one step above the ceiling, naming the revert', () => {
    const v = verdictFor(<LaunchFeePanel />, '10.000000000000000001')
    expect(v.label).toBe('[max_launch_fee_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('LaunchFeeTooHigh')
  })

  it('refuses the wei/ether slip this ceiling exists for', () => {
    // 0.1 ETH entered as its wei value into a field denominated in ETH 鈥?the
    // realistic accident, at its real magnitude.
    const v = verdictFor(<LaunchFeePanel />, '100000000000000000')
    expect(v.label).toBe('[max_launch_fee_violation]')
    expect(v.disabled).toBe(true)
  })

  it('still arms at zero, which is a policy choice and not a mistake', () => {
    // `test_setLaunchFee_allowsZero` on the contract side. A ceiling must not
    // quietly acquire a floor.
    const v = verdictFor(<LaunchFeePanel />, '0')
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('asks for a value before it complains about one', () => {
    const ui = mount(<LaunchFeePanel />)
    try {
      const btn = ui.button('Enter a fee')
      expect(btn.disabled).toBe(true)
    } finally {
      ui.unmount()
    }
  })
})

describe('DEFAULT SOFT CAP dial', () => {
  const READY = 'Set default cap'

  it('arms exactly at the floor', () => {
    const v = verdictFor(<SoftCapPanel />, MIN_SOFT_CAP_PROD_LABEL)
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('refuses below the floor, naming the revert', () => {
    const v = verdictFor(<SoftCapPanel />, '0.009')
    expect(v.label).toBe('[min_soft_cap_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('InvalidSoftCap')
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
