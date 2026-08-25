'use client'

import { useState, useCallback } from 'react'
import { useReadContract } from 'wagmi'
import type { Abi } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'
import { ActionButton, useActionGate, useTxAction } from '@/components/ui'
import { Section, ScopeNote, StatusBadge, ConfirmDialog } from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G3 · SAFETY & RISK
// ─────────────────────────────────────────────────────────────────────────────

export function CircuitBreakerPanel() {
  const [confirming, setConfirming] = useState(false)

  const { data: paused, isLoading, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'paused',
    query: { refetchInterval: 10_000 },
  })

  const isPaused = paused === true

  const tx = useTxAction({
    action: isPaused ? 'resume the platform' : 'engage the circuit breaker',
    onConfirmed: () => { void refetch() },
  })

  const submit = useCallback(() => {
    setConfirming(false)
    tx.send({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI as unknown as Abi,
      functionName: isPaused ? 'unpause' : 'pause',
      args: [],
    })
  }, [isPaused, tx])

  const gate = useActionGate({
    action: isPaused ? 'Resume platform' : 'Engage circuit breaker',
    onAct: () => setConfirming(true),
    tx,
  })

  return (
    <Section
      id="G3-A" title="PLATFORM CIRCUIT BREAKER"
      subtitle="pause / unpause · Pausable guard on the factory's entry points"
      action={isLoading && paused === undefined
        ? <span className="text-label font-mono text-text-tertiary">reading…</span>
        : <StatusBadge ok={!isPaused} okLabel="live" badLabel="paused" />}
    >
      <ScopeNote tone={isPaused ? 'warn' : 'mute'}>
        Scope is deliberately narrow. Pausing halts new project creation and PoG
        registration and nothing else. Secondary trading on launched pools, shelf
        minting, genesis claims and depositor refunds all keep working — those
        live in the hooks, which the factory has no authority over once deployed.
        This is a spam and incident brake, not a kill switch. To stop shelf
        minting on a project that has already launched, use the ladder halt in
        G3-B — it is a separate switch precisely so this one keeps meaning what
        it says.
      </ScopeNote>
      <ScopeNote tone="warn">
        <span className="text-danger">Deposits are not paused.</span>{' '}
        <code>deposit</code> carries no <code>whenNotPaused</code>, so a genesis
        round that is already open goes on taking ETH for its full window while
        the platform is paused. That is the same promise that keeps refunds
        working — once the platform has taken money for a round it cannot starve
        it — but it cuts both ways: if an incident requires stopping the inflow,
        this button is not sufficient and you need the blacklist below.
      </ScopeNote>

      <ActionButton gate={gate} full={false} intent={isPaused ? 'primary' : 'danger'} />

      <ConfirmDialog
        open={confirming}
        title={isPaused ? 'Resume the platform?' : 'Engage the circuit breaker?'}
        body={isPaused
          ? 'createLaunch and registerPoG reopen immediately on confirmation.'
          : 'createLaunch and registerPoG stop accepting transactions. Deposits into rounds that are already open, live pools, shelf mints and refunds are all unaffected.'}
        confirmLabel={isPaused ? 'resume' : 'pause platform'}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
        danger={!isPaused}
      />
    </Section>
  )
}
