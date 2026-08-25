'use client'

/**
 * House toasts, over react-hot-toast.
 *
 * One job: keep every notification on the same visual and verbal footing, and
 * give a transaction one toast that mutates through its whole life instead of
 * four that stack up.
 *
 * NON-OBVIOUS CONSTRAINTS
 *   • The <Toaster/> is mounted once, in providers.tsx.  Do not mount another.
 *   • A user rejecting the wallet prompt is NOT an error.  It arrives as a
 *     thrown `UserRejectedRequestError` and every surface currently renders it
 *     as `[REVERT] User rejected the request`, which reads like the chain
 *     refused them.  `isUserRejection` catches it and the lifecycle helper
 *     dismisses quietly.
 *   • One toast id per transaction, reused across phases, so "submitted" is
 *     replaced by "confirming" rather than joined by it.
 */

import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { testnetExplorerTx } from '@/lib/contracts'
import { truncateTxHash } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

const REJECTION_PATTERNS = [
  'user rejected',
  'user denied',
  'rejected the request',
  'request rejected',
  'userrejectedrequesterror',
]

/** True when the wallet prompt was dismissed by the user, not by the chain. */
export function isUserRejection(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const name = typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const message = error instanceof Error ? error.message : String(error)
  const haystack = `${name} ${message}`.toLowerCase()
  return REJECTION_PATTERNS.some((p) => haystack.includes(p))
}

/**
 * The first useful line of a viem/wagmi error.
 *
 * Those errors carry a multi-paragraph body (Request Arguments, Docs, Version)
 * that is worth nothing in a toast; the first line is the revert reason.
 */
export function shortErrorMessage(error: unknown, max = 160): string {
  if (error === null || error === undefined) return 'Transaction failed'
  const raw = error instanceof Error ? error.message : String(error)
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? raw
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESENTATION
// ─────────────────────────────────────────────────────────────────────────────

function TxBody({ title, hash }: { title: ReactNode; hash?: `0x${string}` }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-tosh-ink">{title}</span>
      {hash !== undefined && (
        <a
          href={testnetExplorerTx(hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-tosh-fluo underline decoration-dotted underline-offset-2"
        >
          {truncateTxHash(hash)} ↗
        </a>
      )}
    </span>
  )
}

export interface ToastOptions {
  id?: string
  /** Milliseconds. Omit for the house default; `Infinity` to pin. */
  duration?: number
}

/**
 * What a toast can render.  Narrower than `ReactNode` on purpose —
 * react-hot-toast cannot take `undefined`, a `bigint` or a fragment array, and
 * silently rendering nothing is worse than not compiling.
 */
export type ToastMessage = string | ReactElement

/**
 * The four notification verbs.  Anything that needs more shape than this
 * belongs in the page, not in a toast.
 */
export const toshToast = {
  success: (message: ToastMessage, options?: ToastOptions) => toast.success(message, options),
  error: (message: ToastMessage, options?: ToastOptions) => toast.error(message, options),
  info: (message: ToastMessage, options?: ToastOptions) => toast(message, options),
  loading: (message: ToastMessage, options?: ToastOptions) => toast.loading(message, options),
  dismiss: (id?: string) => toast.dismiss(id),
  /** Renders a caught error, staying silent on a user rejection. */
  fromError: (error: unknown, options?: ToastOptions) => {
    if (isUserRejection(error)) {
      if (options?.id !== undefined) toast.dismiss(options.id)
      return
    }
    toast.error(shortErrorMessage(error), options)
  },
} as const

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

export interface TxToastLabels {
  /** Verb for the action, lower case: `'deposit'`, `'claim your allocation'`. */
  action: string
  /** Default: `Awaiting signature`. */
  signing?: string
  /** Default: `Submitted · confirming`. */
  confirming?: string
  /** Default: `Confirmed`. */
  confirmed?: string
}

export interface UseTxToastArgs {
  labels: TxToastLabels
  hash: `0x${string}` | undefined
  isPending: boolean
  isConfirming: boolean
  isConfirmed: boolean
  error: Error | null
  /** Turn the whole thing off for a surface that renders its own status. */
  enabled?: boolean
}

type Phase = 'idle' | 'signing' | 'confirming' | 'confirmed' | 'failed'

function resolvePhase(a: UseTxToastArgs): Phase {
  if (a.error !== null) return 'failed'
  if (a.isConfirmed) return 'confirmed'
  if (a.isConfirming || (a.hash !== undefined && !a.isConfirmed)) return 'confirming'
  if (a.isPending) return 'signing'
  return 'idle'
}

/**
 * Drives one toast through submitted → confirming → confirmed / failed.
 *
 * Wire it to the same `useWriteContract` + `useWaitForTransactionReceipt` pair
 * the button already has — or, better, to `useTxAction`, which returns exactly
 * this shape and calls this hook for you.
 */
export function useTxLifecycleToast(args: UseTxToastArgs): void {
  const { labels, hash, error, enabled = true } = args
  const toastId = useId()
  const lastPhase = useRef<Phase>('idle')
  const phase = resolvePhase(args)

  useEffect(() => {
    if (!enabled) return
    if (phase === lastPhase.current) return
    lastPhase.current = phase

    const action = labels.action
    switch (phase) {
      case 'signing':
        toast.loading(labels.signing ?? `Awaiting signature — ${action}`, {
          id: toastId,
          duration: Infinity,
        })
        break
      case 'confirming':
        toast.loading(<TxBody title={labels.confirming ?? `Submitted · confirming ${action}`} hash={hash} />, {
          id: toastId,
          duration: Infinity,
        })
        break
      case 'confirmed':
        toast.success(<TxBody title={labels.confirmed ?? `Confirmed — ${action}`} hash={hash} />, {
          id: toastId,
          duration: 6_000,
        })
        break
      case 'failed':
        if (isUserRejection(error)) toast.dismiss(toastId)
        else toast.error(<TxBody title={shortErrorMessage(error)} hash={hash} />, { id: toastId, duration: 8_000 })
        break
      case 'idle':
        break
    }
  }, [phase, enabled, hash, error, labels, toastId])

  // A fresh hash means a new transaction: let the next phase change open a new
  // toast instead of being swallowed as a no-op.
  useEffect(() => {
    lastPhase.current = 'idle'
  }, [hash])
}
