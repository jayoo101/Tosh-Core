'use client'

/**
 * Top up a short WBNB balance from BNB, for the steps that PULL the quote asset.
 *
 * A genesis deposit needs none of this — `factory.depositNative` wraps inside
 * the call. A shelf mint and an LP add are different: the hook and the position
 * manager call `transferFrom` on WBNB, so the wallet has to hold it first. This
 * names the shortfall and sends `WBNB.deposit{value: shortfall}`, exactly the
 * gap and no more, so nothing extra sits wrapped afterwards.
 *
 * Inert on any asset that does not wrap the native coin: `shortfall` is then
 * always zero and the caller's balance check is the whole story.
 */

import { useCallback } from 'react'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { WRAPPED_NATIVE_ABI } from '@/lib/quoteAssets'
import { useTxAction, type TxAction } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { useQuote } from './quoteContext'

/** BNB kept back for gas when deciding whether wrapping can cover a step. */
export const NATIVE_GAS_RESERVE = 3_000_000_000_000_000n

/** Fill values for the `wrap` strings, which name both forms of the coin. */
export const WRAP_VARS = { native: NATIVE_SYMBOL, wrapped: `W${NATIVE_SYMBOL}` }

export interface WrapNative {
  /** WBNB the step needs beyond what the wallet holds. Zero when none, or not a WBNB project. */
  shortfall: bigint
  /** The shortfall is coverable from BNB while leaving gas. */
  canWrap: boolean
  /** Neither the wrapped balance nor wrapping can cover the step. */
  insufficient: boolean
  wrap: () => void
  tx: TxAction
}

export function useWrapNative(
  needed: bigint,
  wrappedBalance: bigint,
  nativeBalance: bigint,
  onConfirmed: () => void,
): WrapNative {
  const t = useT().wrap
  const quote = useQuote()
  const tx = useTxAction({ action: fill(t.txAction, WRAP_VARS), onConfirmed })

  const gap = needed > wrappedBalance ? needed - wrappedBalance : 0n
  const shortfall = quote.wrapsNative ? gap : 0n
  const canWrap = shortfall > 0n && nativeBalance >= shortfall + NATIVE_GAS_RESERVE
  const insufficient = gap > 0n && !canWrap

  const wrap = useCallback(() => {
    if (shortfall === 0n) return
    tx.send({ address: quote.asset, abi: WRAPPED_NATIVE_ABI, functionName: 'deposit', value: shortfall })
  }, [shortfall, quote.asset, tx])

  return { shortfall, canWrap, insufficient, wrap, tx }
}
