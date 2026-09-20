import { describe, expect, it, vi } from 'vitest'

// `phase.ts` pulls `LAUNCH_WINDOW_SECONDS` from `contracts.ts`, which throws at
// import without a factory address. Hoisting beats the static import below.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { resolvePhase } from './phase'
import { LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'

/**
 * A closed genesis has two ways to fail and they run on different clocks.
 *
 * `resolvePhase` re-derives the outcome from the clock instead of trusting the
 * polled `canRefund`, which is right — the poll lags by up to a refetch — but
 * it means every rule the contract gained has to be repeated here or the page
 * falls behind the chain. A raise too small to carry a ladder refunds at
 * genesis close; deriving that from the clock alone would show `awaiting_launch`
 * for seven days over a refund the depositor could already take.
 *
 * The `undefined` case is the one most likely to be "simplified" later into a
 * falsy check. It must not be: a pending read is not a verdict, and treating it
 * as one mounts the refund terminal over every healthy project on first paint.
 */

const DEADLINE = 1_000_000n
const WINDOW = Number(LAUNCH_WINDOW_SECONDS)

function at(nowSec: number, extra: Partial<Parameters<typeof resolvePhase>[0]> = {}) {
  return resolvePhase({
    canRefund: false,
    launched: false,
    genesisDeadline: DEADLINE,
    nowSec,
    ...extra,
  })
}

describe('resolvePhase', () => {
  it('is genesis while deposits are still open, whatever the ladder says', () => {
    expect(at(Number(DEADLINE) - 1, { ladderViable: false })).toBe('genesis')
    expect(at(Number(DEADLINE) - 1, { ladderViable: true })).toBe('genesis')
  })

  it('refunds at genesis close when the raise cannot carry a ladder', () => {
    expect(at(Number(DEADLINE) + 1, { ladderViable: false })).toBe('refund')
  })

  it('waits out the window when the raise could still open a pool', () => {
    expect(at(Number(DEADLINE) + 1, { ladderViable: true })).toBe('awaiting_launch')
    expect(at(Number(DEADLINE) + WINDOW - 1, { ladderViable: true })).toBe('awaiting_launch')
    expect(at(Number(DEADLINE) + WINDOW + 1, { ladderViable: true })).toBe('refund')
  })

  it('treats a pending ladder read as unknown, never as unlaunchable', () => {
    // The whole point: `undefined` must not collapse into `false`.
    expect(at(Number(DEADLINE) + 1, { ladderViable: undefined })).toBe('awaiting_launch')
    expect(at(Number(DEADLINE) + 1)).toBe('awaiting_launch')
  })

  it('lets a launched round outrank every failure', () => {
    expect(at(Number(DEADLINE) + 1, { launched: true, ladderViable: false })).toBe('bonding')
  })

  it('honours the contract when the poll already says refunds are open', () => {
    expect(at(Number(DEADLINE) + 1, { canRefund: true, ladderViable: true })).toBe('refund')
  })

  it('reads an unresolved deadline as loading, not as expired', () => {
    expect(at(0, { genesisDeadline: 0n, ladderViable: false })).toBe('genesis')
  })

  /**
   * Both boundaries are strict in the contract, and a `>=` on either one puts
   * this page a second ahead of the chain — offering a refund whose button
   * reverts with "Refund not available".
   *
   *   deposit()   reverts at  t >= genesisDeadline
   *   launch()    reverts at  t <  genesisDeadline  and at  t > deadline + WINDOW
   *   canRefund() requires    t >  genesisDeadline
   *
   * So at t == genesisDeadline exactly, and again at t == deadline + WINDOW
   * exactly, the only true statement is "launch is still open, refunds are
   * not" — which is `awaiting_launch` in both cases, including for a raise
   * that can never launch. That last one reads as a wrong answer and is not:
   * for that one second the chain will refuse the launch AND refuse the
   * refund, and the page's job is to report the state, not to improve on it.
   */
  it('does not open refunds one second before the contract does', () => {
    expect(at(Number(DEADLINE), { ladderViable: false })).toBe('awaiting_launch')
    expect(at(Number(DEADLINE) + 1, { ladderViable: false })).toBe('refund')

    expect(at(Number(DEADLINE) + WINDOW, { ladderViable: true })).toBe('awaiting_launch')
    expect(at(Number(DEADLINE) + WINDOW + 1, { ladderViable: true })).toBe('refund')
  })
})
