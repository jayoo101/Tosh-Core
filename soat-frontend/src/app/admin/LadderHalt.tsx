'use client'


import { useState, useCallback } from 'react'
import { useReadContract } from 'wagmi'
import { isAddress, getAddress, type Abi, type Address } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS } from '@/lib/contracts'
import {
  ActionButton, useActionGate, useTxAction, revertOrder,
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  type ActionBlocker,
} from '@/components/ui'
import {
  Section,
  labelCls,
  ScopeNote,
  Field,
  Readout,
  StatusBadge,
  ConfirmDialog,
  useNowSec,
} from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G3-B · LADDER HALT — the only platform brake that reaches a launched project
// ─────────────────────────────────────────────────────────────────────────────
//
// Kept visually separate from the circuit breaker above because the two answer
// different questions: `pause()` stops the platform GROWING, this stops the
// ladder SELLING.  Folding them into one toggle would have made "paused" mean
// something quietly larger than what the factory's own natspec promises.
//
// The halt expires on its own, so the panel leads with the deadline rather than
// with a boolean: an operator's next question after "is it halted" is always
// "for how much longer", and a halt that lapses unnoticed mid-incident is the
// failure mode worth designing against.

export const HALT_PRESETS = [
  { label: '1 h',  secs: 3_600n },
  { label: '24 h', secs: 86_400n },
  { label: '72 h', secs: 259_200n },
  { label: '7 d',  secs: 604_800n },
] as const

export function LadderHaltPanel() {
  const nowSec = useNowSec()
  const [scope, setScope]           = useState<'global' | 'hook'>('global')
  const [hookInput, setHookInput]   = useState('')
  const [duration, setDuration]     = useState<bigint>(86_400n)
  const [confirming, setConfirming] = useState(false)

  const { data: globalUntil, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'globalLadderHaltedUntil',
    query: { refetchInterval: 10_000 },
  })

  const targeted = scope === 'hook' && isAddress(hookInput.trim())
    ? (getAddress(hookInput.trim()) as Address)
    : undefined

  const { data: hookUntil, refetch: refetchHook } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookLadderHaltedUntil',
    args: targeted ? [targeted] : undefined,
    query: { enabled: !!targeted, refetchInterval: 10_000 },
  })

  const tx = useTxAction({
    action: 'change the ladder halt',
    onConfirmed: () => { void refetch(); void refetchHook() },
  })

  const activeUntil  = scope === 'global' ? (globalUntil as bigint | undefined) : (hookUntil as bigint | undefined)
  // `haltLadderMinting` caps a halt at MAX_HALT_DURATION, so this stamp is
  // always representable — but reading it through the horizon means the panel
  // does not depend on that cap holding forever.
  const haltHorizon  = classifyHorizon(activeUntil ?? 0n, nowSec)
  const isHalted     = haltHorizon.kind === 'pending' || haltHorizon.kind === 'unbounded'
  const targetArg    = scope === 'global' ? ZERO_ADDRESS : targeted

  const submit = useCallback((resume: boolean) => {
    setConfirming(false)
    if (!targetArg) return
    tx.send({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI as unknown as Abi,
      functionName: resume ? 'resumeLadderMinting' : 'haltLadderMinting',
      args: resume ? [targetArg] : [targetArg, duration],
    })
  }, [targetArg, duration, tx])

  // Shared by both levers: a project-scoped halt needs a project.
  const targetBlocker: ActionBlocker = {
    id: 'halt-target-missing',
    active: scope === 'hook' && targeted === undefined,
    label: hookInput.trim() === '' ? 'Enter a hook address' : '[not_an_address]',
    reason: hookInput.trim() === ''
      ? 'Paste the hook address this halt applies to, or switch back to platform-wide.'
      : 'That is not a well-formed hook address.',
    tone: hookInput.trim() === '' ? 'neutral' : 'danger',
  }

  const haltGate = useActionGate({
    action: `Halt ladder · ${HALT_PRESETS.find(p => p.secs === duration)?.label ?? ''}`,
    onAct: () => setConfirming(true),
    tx,
    blockersInRevertOrder: revertOrder(targetBlocker),
  })

  const resumeGate = useActionGate({
    action: 'Resume now',
    onAct: () => submit(true),
    tx,
    blockersInRevertOrder: revertOrder(targetBlocker),
  })

  return (
    <Section
      id="G3-B" title="LADDER HALT"
      subtitle="haltLadderMinting / resumeLadderMinting · suspends shelf minting on projects that have already launched"
      action={<StatusBadge ok={!isHalted} okLabel="ladder live" badLabel="halted" />}
    >
      <div className="flex gap-2">
        {(['global', 'hook'] as const).map(s => (
          <button
            key={s} type="button" onClick={() => setScope(s)}
            className={'px-3 py-1.5 text-label tracking-[0.28em] uppercase font-bold border transition-colors ' +
              (scope === s
                ? 'border-brand text-brand'
                : 'border-border-subtle text-text-tertiary hover:text-text-secondary')}
          >
            {s === 'global' ? 'platform-wide' : 'single project'}
          </button>
        ))}
      </div>

      {scope === 'hook' && (
        <Field
          label="HOOK ADDRESS"
          value={hookInput}
          onChange={setHookInput}
          placeholder="0x… the project's hook, not its token"
          disabled={tx.isBusy}
          fluo={targeted !== undefined}
        />
      )}

      <Readout
        label="HALTED UNTIL"
        value={isHalted ? (formatHorizonUtc(haltHorizon, 'second') ?? 'halted') : 'not halted'}
        hint={isHalted
          ? formatHorizonLabel(haltHorizon, {
              unbounded: 'no representable expiry',
              elapsed:   'lapsed',
              pending:   d => `${d} remaining`,
            })
          : null}
        tone={isHalted ? 'fluo' : 'mute'}
      />

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>HALT DURATION</span>
        <div className="flex gap-2 flex-wrap">
          {HALT_PRESETS.map(p => (
            <button
              key={p.label} type="button" onClick={() => setDuration(p.secs)}
              disabled={tx.isBusy}
              className={'px-3 py-1.5 text-label tracking-[0.28em] uppercase font-bold border transition-colors ' +
                (duration === p.secs
                  ? 'border-brand text-brand'
                  : 'border-border-subtle text-text-tertiary hover:text-text-secondary')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <ScopeNote tone="warn">
        Reaches <code>mintBondingCurve</code> and nothing else. Pool swaps, LP
        add/remove, genesis claims, referral claims and depositor refunds all
        keep working, so a halt can cancel an opportunity but can never strand a
        balance.
        <br /><br />
        <span className="text-text-secondary">It expires by itself.</span> A halt is a
        deadline, capped at 7 days, not a flag — so an owner who is compromised
        or simply unavailable cannot brick Phase 2 permanently. Re-arm before the
        deadline to extend an ongoing incident; the worst case is a rolling
        outage that has to be renewed on-chain, in public, every week.
      </ScopeNote>

      <div className="flex items-start gap-4 flex-wrap">
        <ActionButton gate={haltGate} full={false} intent="danger" />
        {isHalted && <ActionButton gate={resumeGate} full={false} showReason={false} />}
      </div>

      <ConfirmDialog
        open={confirming}
        title={scope === 'global' ? 'Halt every ladder?' : 'Halt this project\u2019s ladder?'}
        body={
          `Shelf minting stops immediately and resumes automatically after ` +
          `${HALT_PRESETS.find(p => p.secs === duration)?.label ?? ''}. ` +
          `Trading, LP, claims and refunds are unaffected. ` +
          (scope === 'global'
            ? 'This applies to every launched project on the platform.'
            : `Scoped to ${targeted ?? '—'} only.`)
        }
        confirmLabel="halt ladder"
        onConfirm={() => submit(false)}
        onCancel={() => setConfirming(false)}
        danger
      />
    </Section>
  )
}
