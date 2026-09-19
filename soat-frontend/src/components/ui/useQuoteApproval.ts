'use client'

/**
 * The allowance step in front of every quote-denominated action.
 *
 * One job: say whether `spender` may pull `amount` of the quote asset from the
 * connected wallet, and send the approve that makes it so.
 *
 * WHY THIS EXISTS AT ALL
 * ──────────────────────
 * It did not, until the quote asset stopped being the native coin. A deposit used
 * to carry its own funding — `value: amountWei` and the money arrived with the
 * call, so there was nothing to authorise and no state between the user and the
 * button. An ERC-20 quote asset is PULLED: the factory and the per-project hooks
 * call `transferFrom`, which means every one of those actions is now two
 * transactions and can fail in a new way that has nothing to do with the protocol.
 *
 * That "new way" is the reason this is centralised rather than inlined three times.
 * A missing allowance does not look like a missing allowance from the wallet: the
 * popup opens, the user signs, and the transaction reverts having spent gas. The
 * only way to keep that from happening is for the UI to know the allowance BEFORE
 * it enables the button, and one implementation of that is easier to keep honest
 * than three.
 *
 * NON-OBVIOUS CONSTRAINTS
 *   • EXACT AMOUNTS, NOT `type(uint256).max`. The spenders are the factory and
 *     per-project hook clones, and while a clone's code is fixed by the
 *     implementation it points at, an unlimited allowance is still a standing
 *     claim on the user's entire balance held by a contract some stranger
 *     deployed. The cost of exactness is real and worth naming: every deposit and
 *     every shelf mint is two transactions, forever, not two the first time and
 *     one thereafter.
 *   • A residue is normal, and is not a bug. `mintBondingCurve` is approved for
 *     its `maxCost` bound and charges the true cost, so a few base units of
 *     allowance usually survive the call. The next approve therefore overwrites a
 *     live nonzero allowance, which plain ERC-20 permits and USDT-style tokens
 *     refuse. BEM permits it — measured against deployed bytecode in
 *     `test_fork_realBemApproveAcceptsANonzeroToNonzeroChange`, not assumed here.
 *     If that test ever fails this hook needs a zero-first step.
 *   • `'unknown'` is a distinct state from `'required'`. A disconnected wallet and
 *     an in-flight allowance read both mean "cannot say", and a caller that
 *     collapses them into "approval required" shows an approve button to someone
 *     who has already approved, on every first frame after mount.
 */

import { useCallback } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { QUOTE_ASSET, ERC20_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'
import { useTxAction, type TxAction } from './useTxAction'

/**
 * Whether the pull can happen.
 *
 *   unknown     — no wallet, or the allowance has not been read yet. Say nothing.
 *   sufficient  — `spender` may pull `amount` today.
 *   required    — it may not; `approve` is the fix and `shortfall` is the gap.
 */
export type QuoteApprovalState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'sufficient'; readonly allowance: bigint }
  | { readonly kind: 'required'; readonly allowance: bigint; readonly shortfall: bigint }

export interface QuoteApproval {
  state: QuoteApprovalState
  /** True only for `'required'`; the shorthand callers actually branch on. */
  needsApproval: boolean
  /** Sends `approve(spender, amount)`. No-op unless `'required'`. */
  approve: () => void
  /** The approve transaction's own lifecycle, for gating the action button. */
  tx: TxAction
  /** Re-reads the allowance. Called for you when the approve confirms. */
  refetch: () => void
}

/**
 * @param spender who will call `transferFrom` — the factory for a launch fee or a
 *                genesis deposit, the project's own hook for a shelf mint.
 * @param amount  the exact figure the action will pull. For a bounded call such
 *                as `mintBondingCurve` this is the bound, not the expected charge.
 */
export function useQuoteApproval(
  spender: Address | undefined,
  amount: bigint,
): QuoteApproval {
  const { address: owner } = useAccount()

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: QUOTE_ASSET,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: owner && spender ? [owner, spender] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: owner !== undefined && spender !== undefined },
  })

  const refetch = useCallback(() => { void refetchAllowance() }, [refetchAllowance])

  const tx = useTxAction({
    action: 'approve',
    labels: { confirmed: 'Approved — the pull is authorised' },
    // The allowance the action button reads is now stale, and nothing else will
    // notice: `useReadContract` has no reason to refetch on someone else's
    // receipt. Without this the approve confirms and the button stays disabled.
    onConfirmed: refetch,
  })

  const state: QuoteApprovalState =
    owner === undefined || spender === undefined || allowance === undefined
      ? { kind: 'unknown' }
      : allowance >= amount
        ? { kind: 'sufficient', allowance }
        : { kind: 'required', allowance, shortfall: amount - allowance }

  const approve = useCallback(() => {
    if (spender === undefined || amount <= 0n) return
    tx.send({
      address: QUOTE_ASSET,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    })
  }, [spender, amount, tx])

  return { state, needsApproval: state.kind === 'required', approve, tx, refetch }
}
