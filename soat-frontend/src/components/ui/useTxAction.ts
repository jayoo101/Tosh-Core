'use client'

/**
 * One contract write, from signature to receipt.
 *
 * One job: pair `useWriteContract` with `useWaitForTransactionReceipt`, bind
 * the chain id, drive the lifecycle toast, and expose a single `isBusy`.
 *
 * NON-OBVIOUS CONSTRAINTS
 *   • `chainId` is not part of `TxRequest`, and that is the point.  Every
 *     write in this app must be pinned to `TARGET_CHAIN_ID` or a wallet parked
 *     on another network will happily broadcast to it.  Binding it here means
 *     a caller cannot forget, and cannot override it either.
 *   • `isBusy` is `isPending || isConfirming`, derived once.  Every panel in
 *     ProjectTerminal and admin/page re-derives that pair by hand today; hand
 *     this straight to `useActionGate({ tx })` instead.
 *   • `abi` is typed as viem's widened `Abi`.  Per-function argument inference
 *     is given up deliberately: `HOOK_ABI` alone is ~130 entries and wagmi's
 *     per-entry mapped type blows past TypeScript's instantiation depth when
 *     it is threaded through another generic wrapper.  ProjectTerminal already
 *     hit this and left a comment about it.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { Abi, Address, Hash, TransactionReceipt } from 'viem'

/**
 * The receipt shape `onConfirmed` hands back.
 *
 * viem's plain `TransactionReceipt` rather than wagmi's
 * `WaitForTransactionReceiptData`, which is generic over config and chain id:
 * naming that one means restating both parameters at every call site and
 * keeping them in step with `providers.tsx`. Callers only ever want `logs` and
 * `status`, which are common to both.
 */
export type TxReceipt = TransactionReceipt
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { useTxLifecycleToast, type TxToastLabels } from './toast'

export interface TxRequest {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  /** Payable calls only; the widened ABI cannot prove that for you. */
  value?: bigint
}

export interface TxActionOptions {
  /**
   * Lower-case verb for the toast copy: `'deposit'`, `'claim your allocation'`.
   * Reads as "Confirmed — deposit".
   */
  action: string
  /** Overrides for individual lifecycle lines. */
  labels?: Omit<TxToastLabels, 'action'>
  /**
   * Fires once per confirmed receipt, and never for one that reverted.
   *
   * The receipt is handed over so a caller that needs the logs does not open a
   * second `useWaitForTransactionReceipt` on the same hash to get them. One
   * panel did exactly that, checked only `isSuccess`, and thereby reintroduced
   * the revert-is-success bug this hook was written to fix — while also
   * doubling receipt polling for every transaction it sent.
   */
  onConfirmed?: (receipt: TxReceipt) => void
  /** Off for a surface that renders its own status line. Default true. */
  toast?: boolean
}

export interface TxAction {
  /** Fire and forget; errors land on `error`. */
  send: (request: TxRequest) => void
  /** Resolves with the hash, rejects on wallet rejection or RPC failure. */
  sendAsync: (request: TxRequest) => Promise<Hash>
  hash: Hash | undefined
  isPending: boolean
  isConfirming: boolean
  isConfirmed: boolean
  /** `isPending || isConfirming`. Pass to `useActionGate({ tx: { isBusy } })`. */
  isBusy: boolean
  error: Error | null
  reset: () => void
}

export function useTxAction(options: TxActionOptions): TxAction {
  const { action, labels, onConfirmed, toast = true } = options

  const {
    writeContract,
    writeContractAsync,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract()

  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: receiptSettled,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash })

  /**
   * `isSuccess` on this query means "the receipt arrived", not "the call
   * worked". viem resolves normally for a transaction that mined and then
   * reverted, so the outcome lives in `receipt.status` and nowhere else.
   * Reading only `isSuccess` reported every on-chain revert as "Confirmed"
   * and fired `onConfirmed`, refetching state that had not changed.
   */
  const reverted = receipt?.status === 'reverted'
  const isConfirmed = receiptSettled && !reverted

  const send = useCallback(
    (request: TxRequest) => {
      writeContract({ ...request, chainId: TARGET_CHAIN_ID })
    },
    [writeContract],
  )

  const sendAsync = useCallback(
    (request: TxRequest) => writeContractAsync({ ...request, chainId: TARGET_CHAIN_ID }),
    [writeContractAsync],
  )

  const error =
    writeError ??
    receiptError ??
    (reverted
      ? new Error('Reverted on-chain — the contract rejected this call.')
      : null)

  useTxLifecycleToast({
    labels: { action, ...labels },
    hash,
    isPending,
    isConfirming,
    isConfirmed,
    error,
    enabled: toast,
  })

  // Once per receipt, not once per render pass that happens to see isConfirmed.
  const settled = useRef<Hash | null>(null)
  useEffect(() => {
    if (!isConfirmed || hash === undefined || !receipt) return
    if (settled.current === hash) return
    settled.current = hash
    onConfirmed?.(receipt)
  }, [isConfirmed, hash, receipt, onConfirmed])

  return {
    send,
    sendAsync,
    hash,
    isPending,
    isConfirming,
    isConfirmed,
    isBusy: isPending || isConfirming,
    error,
    reset,
  }
}
