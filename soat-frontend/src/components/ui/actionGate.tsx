'use client'

/**
 * The Smart CTA state machine.
 *
 * One job: collapse every reason an action cannot fire into ONE verdict, so an
 * action card renders one button whose label, enabled state and click handler
 * are all derived rather than hand-wired.
 *
 * The canonical progression:
 *
 *   Connect Wallet → Switch Network → «domain blockers, in revert order»
 *                  → Deposit / Mint / Launch / Refund / Claim
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDERING INVARIANT — read this before writing a blocker list.
 *
 * A blocker list must name the condition that would ACTUALLY revert the
 * transaction, which means it must be in the same order the contract checks.
 * `factory.deposit` rejects in this sequence and no other:
 *
 *      blacklist  →  missing PoG quota  →  active cooldown  →  quota exceeded
 *
 * Naming a later condition than the true one is not a cosmetic slip.  Tell a
 * blacklisted wallet to "run the PoG scan" and it will sign a transaction that
 * reverts; tell it to "wait for your window" and it waits forever.  Note also
 * that `factory.eligibility` collapses the first three into the same
 * `(false, 0, 0)` an exhausted window produces — a zero `remainingQuota` under
 * a live cooldown means UNREADABLE, not exhausted.
 *
 * `blockersInRevertOrder` is an ordered array, and `revertOrder(...)` is how
 * you build one.  A `Set` or a record keyed by name would be the wrong shape
 * precisely because neither can express the thing that matters here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * REPLACES: the `armed = !a && !b && !c && …` chains plus the nested ternary
 * `lockedLabel` ladders in GenesisPanel and BondingPanel, the `step` IIFE in
 * LiquidityPanel, the `Action` IIFE in launch/page's LaunchCTA, and
 * `WriteAccessContext` + `WriteButton`'s owner gate in admin/page.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAccount, useConnect, useSwitchChain } from 'wagmi'
import { TARGET_CHAIN_ID, ACTIVE_CHAIN_LABEL } from '@/lib/contracts'
import { useWalletChainId } from '@/lib/useWalletChainId'
import { useIsHydrated } from './useClock'
import { toshToast } from './toast'
import type { Tone } from './Badge'

/**
 * Connect and switch-chain used the `mutate` variants, so a failure landed on
 * hook state nobody read: dismissing the wallet's network prompt just
 * re-enabled the button with nothing said. `fromError` is already silent for a
 * user-dismissed prompt, so this only speaks up for the failures worth
 * reporting — a locked wallet, or a chain the wallet refuses to add.
 */
function reportWalletFailure(error: unknown): void {
  toshToast.fromError(error)
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKERS
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionBlocker {
  /** Stable identifier. For telemetry and tests — never for ordering. */
  readonly id: string
  /** True when this condition currently stops the transaction. */
  readonly active: boolean
  /**
   * Button label while this blocker binds, e.g. `Wallet blocked`.
   *
   * On the public panels this is a short phrase a depositor can act on. The
   * `[snake_case_code]` form these all started as belongs to `/admin`, where
   * the reader is an operator who wants the identifier — out here it made the
   * button face read like a stack trace.
   */
  readonly label: string
  /** One sentence saying why, and what would change it. Never swallowed. */
  readonly reason: string
  /** Defaults to `'danger'`. Drives the button and the hint colour. */
  readonly tone?: Extract<Tone, 'danger' | 'warn' | 'info' | 'neutral'>
  /**
   * Makes the blocker actionable: the button stays enabled and clicking it
   * runs this instead of the main action.  For blockers the user can clear
   * themselves — "Run the gas-proof scan", "Approve PERMIT2".
   */
  readonly resolve?: () => void
}

/**
 * An ordered blocker list.  Index 0 is evaluated first.
 *
 * Omitting a blocker is fine.  Reordering one is a correctness bug.
 */
export function revertOrder(
  ...blockers: readonly (ActionBlocker | false | null | undefined)[]
): readonly ActionBlocker[] {
  const out: ActionBlocker[] = []
  for (const b of blockers) if (b) out.push(b)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// AMBIENT GATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A page-level permission verdict — the admin console's "is this wallet the
 * factory owner".
 *
 * INVARIANT: any button whose on-chain authority is NOT the ambient authority
 * must set `bypassAmbientGate`.  `acceptOwnership` is the canonical case: the
 * pending owner is by definition not yet the owner, and gating it on ownership
 * produced a true dead-lock where the UI detected the pending owner, told them
 * to accept, and disabled the button.  A bypassing button MUST supply its own
 * blocker (`iAmPending`) in exchange.
 */
export interface AmbientGate {
  allowed: boolean
  /** Why writes are off. Rendered on hover. */
  reason: string | null
  /** Label while closed. Default `[read_only]`. */
  label?: string
}

const OPEN_GATE: AmbientGate = { allowed: true, reason: null }

const AmbientGateContext = createContext<AmbientGate>(OPEN_GATE)

export function ActionGateProvider({
  value,
  children,
}: {
  value: AmbientGate
  children: ReactNode
}) {
  return <AmbientGateContext.Provider value={value}>{children}</AmbientGateContext.Provider>
}

export function useAmbientGate(): AmbientGate {
  return useContext(AmbientGateContext)
}

// ─────────────────────────────────────────────────────────────────────────────
// VERDICT
// ─────────────────────────────────────────────────────────────────────────────

export type VerdictTone = 'ok' | 'danger' | 'warn' | 'info' | 'neutral'

/**
 * Discriminated on `kind`, because the states are mutually exclusive and the
 * caller should never have to ask "is it disabled AND busy AND blocked".
 */
export type ActionVerdict =
  | {
      kind: 'connect'
      label: string
      reason: string | null
      tone: 'info'
      disabled: boolean
      act: (() => void) | null
    }
  | {
      kind: 'switch'
      label: string
      reason: string
      tone: 'warn'
      disabled: boolean
      act: () => void
    }
  | {
      kind: 'busy'
      label: string
      reason: null
      tone: 'neutral'
      disabled: true
      act: null
      phase: 'signing' | 'confirming'
    }
  | {
      kind: 'blocked'
      label: string
      reason: string
      tone: VerdictTone
      /** False when the blocker carries a `resolve` the user can click. */
      disabled: boolean
      act: (() => void) | null
      blockerId: string
    }
  | {
      kind: 'ready'
      label: string
      reason: null
      tone: 'ok'
      disabled: false
      act: () => void
    }

export interface ActionGateOptions {
  /** The terminal label once nothing blocks: `'Deposit'`, `'Claim refund'`. */
  action: string
  /** What fires on a `ready` click. */
  onAct: () => void
  /**
   * Domain blockers IN ON-CHAIN REVERT ORDER. Build with `revertOrder(...)`.
   * The first `active` one wins.
   */
  blockersInRevertOrder?: readonly ActionBlocker[]
  /** Folded in from `useTxAction`. */
  tx?: { isPending?: boolean; isConfirming?: boolean; isBusy?: boolean }
  /**
   * Opts this button out of the ambient page gate. See `AmbientGate`.
   * A button that sets this MUST carry its own blockers.
   */
  bypassAmbientGate?: boolean
  /** Off for actions that read nothing on-chain. Default true. */
  requiresWallet?: boolean
  /** Off for off-chain actions (a signed API call). Default true. */
  requiresNetwork?: boolean
}

export interface ActionGate {
  verdict: ActionVerdict
  isConnected: boolean
  isWrongNetwork: boolean
  /** True until hydration; the verdict is held at a deterministic value. */
  isResolving: boolean
}

/**
 * Derives one verdict from wallet state, network, the ambient gate, the
 * ordered blockers, and the in-flight transaction.
 *
 * Wallet-not-connected and wrong-network are handled here, once, so no surface
 * reimplements them — and wrong-network offers the switch as the action itself
 * rather than as a sentence telling the user to go and do it.
 */
export function useActionGate(options: ActionGateOptions): ActionGate {
  const {
    action,
    onAct,
    blockersInRevertOrder,
    tx,
    bypassAmbientGate = false,
    requiresWallet = true,
    requiresNetwork = true,
  } = options

  const hydrated = useIsHydrated()
  const { isConnected } = useAccount()
  const chainId = useWalletChainId()
  const { connectAsync, connectors, isPending: isConnecting } = useConnect()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()
  const ambient = useAmbientGate()

  const connected = hydrated && isConnected
  const isWrongNetwork = connected && chainId !== TARGET_CHAIN_ID

  const isPending = tx?.isPending ?? false
  const isConfirming = tx?.isConfirming ?? false
  const busy = tx?.isBusy ?? (isPending || isConfirming)

  const firstBlocker = useMemo(
    () => blockersInRevertOrder?.find((b) => b.active) ?? null,
    [blockersInRevertOrder],
  )

  const verdict = useMemo<ActionVerdict>(() => {
    // Held deterministic until hydration so the server markup and the first
    // client paint agree. Replaces the `mounted` flag every surface carries.
    if (!hydrated) {
      return {
        kind: 'connect',
        label: 'Connect Wallet',
        reason: null,
        tone: 'info',
        disabled: true,
        act: null,
      }
    }

    if (requiresWallet && !isConnected) {
      const connector = connectors[0]
      return {
        kind: 'connect',
        label: isConnecting ? 'Connecting…' : 'Connect Wallet',
        reason: 'No wallet is connected to this session.',
        tone: 'info',
        disabled: isConnecting || connector === undefined,
        act: connector === undefined
          ? null
          : () => { void connectAsync({ connector }).catch(reportWalletFailure) },
      }
    }

    if (requiresNetwork && isWrongNetwork) {
      return {
        kind: 'switch',
        label: isSwitching ? 'Switching…' : `Switch to ${ACTIVE_CHAIN_LABEL}`,
        reason: chainId === undefined
          ? `This wallet has not reported a chain. Tosh settles on chain ${TARGET_CHAIN_ID}; every write is pinned to it and would be rejected from anywhere else.`
          : `This wallet is on chain ${chainId}. Tosh settles on chain ${TARGET_CHAIN_ID}; every write is pinned to it and would be rejected from here.`,
        tone: 'warn',
        disabled: isSwitching,
        act: () => {
          void switchChainAsync({ chainId: TARGET_CHAIN_ID }).catch(reportWalletFailure)
        },
      }
    }

    if (busy) {
      return {
        kind: 'busy',
        label: isConfirming ? 'Confirming…' : 'Awaiting signature…',
        reason: null,
        tone: 'neutral',
        disabled: true,
        act: null,
        phase: isConfirming ? 'confirming' : 'signing',
      }
    }

    if (!bypassAmbientGate && !ambient.allowed) {
      return {
        kind: 'blocked',
        label: ambient.label ?? '[read_only]',
        reason: ambient.reason ?? 'This wallet is not authorised for this action.',
        tone: 'neutral',
        disabled: true,
        act: null,
        blockerId: 'ambient-gate',
      }
    }

    if (firstBlocker !== null) {
      return {
        kind: 'blocked',
        label: firstBlocker.label,
        reason: firstBlocker.reason,
        tone: firstBlocker.tone ?? 'danger',
        disabled: firstBlocker.resolve === undefined,
        act: firstBlocker.resolve ?? null,
        blockerId: firstBlocker.id,
      }
    }

    return { kind: 'ready', label: action, reason: null, tone: 'ok', disabled: false, act: onAct }
  }, [
    hydrated,
    requiresWallet,
    isConnected,
    isConnecting,
    connectors,
    connectAsync,
    requiresNetwork,
    isWrongNetwork,
    isSwitching,
    switchChainAsync,
    chainId,
    busy,
    isConfirming,
    bypassAmbientGate,
    ambient,
    firstBlocker,
    action,
    onAct,
  ])

  return { verdict, isConnected: connected, isWrongNetwork, isResolving: !hydrated }
}
