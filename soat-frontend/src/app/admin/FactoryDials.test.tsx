// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import {
  MAX_LAUNCH_FEE_LABEL,
  MIN_SOFT_CAP_PROD_LABEL,
  MAX_COOLDOWN_SECONDS,
} from '@/lib/contracts'

import { LaunchFeePanel, SoftCapPanel, PogLimitPanel, CooldownDurationPanel } from './FactoryDials'

/**
 * The two 20,000-unit ceilings are typed as plain digits rather than through their
 * `_LABEL` exports, which carry thousands separators for the UI. `MAX_LAUNCH_FEE`
 * is small enough that its label doubles as a typeable value; these are not.
 *
 * Both were `'1000000'` — the 1 M ETH ceilings from before the quote-asset
 * re-denomination. That is 50× the current bound, so the two "arms exactly at the
 * ceiling" tests began failing outright. Worth noting that the two "refuses one wei
 * above" tests did NOT fail: they type `1000000.000000000000000001`, which is still
 * above the new ceiling, so they went on passing while testing something other than
 * the boundary they name. Both are re-pinned below.
 */
const MAX_SOFT_CAP_TYPED = '20000'
const MAX_POG_LIMIT_TYPED = '20000'

/**
 * One base unit above each ceiling — 1e-8, not the 1e-18 these used to carry.
 *
 * `parseUnits(x, 8)` does not reject extra decimal places, it truncates them, so
 * `20000.000000000000000001` parses to exactly the ceiling and arms. A test asserting
 * a refusal one step above the bound therefore has to step by the quote asset's
 * actual smallest unit or it is asserting nothing.
 */
const ONE_UNIT_ABOVE_SOFT_CAP = '20000.00000001'
const ONE_UNIT_ABOVE_POG_LIMIT = '20000.00000001'

/**
 * ⚠ THE LAUNCH FEE STEPS BY 1e-18, NOT 1e-8, AND IT IS THE ONLY ONE THAT DOES.
 *   It is the single factory dial charged in native BNB; the two above are
 *   8-decimal BEM. Stepping this one by the quote asset's unit would hand
 *   `parseUnits(x, 18)` a value 1e10 above the ceiling — still a refusal, so
 *   the test would stay green while testing a figure nowhere near the boundary
 *   it names. That is the same failure the comment above records for the old
 *   1e-18 steps on the BEM dials, arriving from the opposite direction.
 */
const ONE_UNIT_ABOVE_LAUNCH_FEE = '0.500000000000000001'

/**
 * The bounded admin dials, tested through the affordance rather than the arithmetic.
 *
 * Each of these three panels refuses a value the factory would revert on, and
 * until now none of them had a test — recorded as a gap because the suite had no
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
    const v = verdictFor(<LaunchFeePanel />, ONE_UNIT_ABOVE_LAUNCH_FEE)
    expect(v.label).toBe('[max_launch_fee_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('LaunchFeeTooHigh')
  })

  it('refuses the wei/ether slip this ceiling exists for', () => {
    // 0.005 BNB entered as its wei value into a field denominated in BNB — the
    // realistic accident, at its real magnitude.
    const v = verdictFor(<LaunchFeePanel />, '5000000000000000')
    expect(v.label).toBe('[max_launch_fee_violation]')
    expect(v.disabled).toBe(true)
  })

  /**
   * The slip the ceiling CANNOT catch, pinned so that nobody reads the test
   * above as covering both directions.
   *
   * A fee typed with the quote asset's scale in mind — `0.005` meant as base
   * units — is not a large number, it is a tiny one: 0.005 BNB parses to 5e15
   * wei and arms, which is correct, but the same field would accept a figure
   * a thousand times too small just as happily. `MAX_LAUNCH_FEE` is a ceiling
   * and has nothing to say about a fee that is too cheap.
   *
   * That asymmetry is why `parseNativeInput` exists as its own function rather
   * than as a decimals argument on `parseEthInput`: routing this dial through
   * the 8-decimal parser produces 500000 wei, sets successfully, reverts
   * nothing, and is discovered when the anti-spam toll stops deterring spam.
   */
  it('arms on a plausible fee, since no bound protects against one too small', () => {
    const v = verdictFor(<LaunchFeePanel />, '0.005')
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
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
    // One base unit below the floor, where this used to be `'0.009'` — a value
    // chosen to sit just under a 0.01 ETH floor and now four orders of magnitude
    // under a 100-unit one. It still refused, but it stopped testing the boundary
    // and would have gone on passing if the floor check had been dropped entirely.
    const v = verdictFor(<SoftCapPanel />, '99.99999999')
    expect(v.label).toBe('[min_soft_cap_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('InvalidSoftCap')
  })

  it('arms exactly at the ceiling', () => {
    const v = verdictFor(<SoftCapPanel />, MAX_SOFT_CAP_TYPED)
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })

  it('refuses one wei above the ceiling, naming the revert', () => {
    const v = verdictFor(<SoftCapPanel />, ONE_UNIT_ABOVE_SOFT_CAP)
    expect(v.label).toBe('[max_soft_cap_violation]')
    expect(v.disabled).toBe(true)
    expect(v.reason).toContain('SoftCapTooHigh')
  })

  it('refuses the wei/ether slip: the 10 ETH default typed as its wei value', () => {
    const v = verdictFor(<SoftCapPanel />, '10000000000000000000')
    expect(v.label).toBe('[max_soft_cap_violation]')
    expect(v.disabled).toBe(true)
  })

  it('still arms at a large but real raise, because the ceiling is not a view on size', () => {
    // 10,000 is pinned on the Foundry side too, by
    // `test_setDefaultSoftCap_admitsALargeButRealRaise`, which carries the note on
    // where the number came from. A ceiling tightened to something tidy would fail
    // here first.
    //
    // THE TWO HAD SILENTLY DRIFTED APART: this said 8000 while the Solidity test
    // moved to 10_000e8 at the re-denomination. Both values are under the 20,000
    // ceiling, so both sides passed and the cross-language pin — the entire point of
    // naming the Foundry test here — was no longer pinning anything to anything.
    const v = verdictFor(<SoftCapPanel />, '10000')
    expect(v.label).toBe(READY)
    expect(v.disabled).toBe(false)
  })
})

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
    // Both blockers live on this dial now. Adding the upper one must not shadow
    // the lower one, which is the blocker that keeps createLaunch alive.
    const v = verdictFor(<PogLimitPanel />, '0')
    expect(v.label).toBe('[invalid_pog_limit]')
    expect(v.disabled).toBe(true)
  })

  it('arms at the 1000-unit limit this repo\'s own fixtures use', () => {
    // Still 1000, and still pinned by `test_setMaxPogAllocationLimit_admitsTheValues
    // ThisSuiteUses`, which sets `1000e8`. Only the title was stale: it said "1000
    // ETH" for a dial that has not been denominated in ETH through two cutovers.
    const v = verdictFor(<PogLimitPanel />, '1000')
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
