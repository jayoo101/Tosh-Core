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
import type { Abi, Address, Hash } from 'viem'
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
  /** Fires once per confirmed receipt. Refetch here. */
  onConfirmed?: () => void
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
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash })

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

  const error = writeError ?? receiptError ?? null

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
    if (!isConfirmed || hash === undefined) return
    if (settled.current === hash) return
    settled.current = hash
    onConfirmed?.()
  }, [isConfirmed, hash, onConfirmed])

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
