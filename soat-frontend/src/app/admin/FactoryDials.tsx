'use client'

/**
 * G1 · FACTORY CONTROL — the forward-looking dials on ToshFactory.
 *
 * The launch fee and the default soft cap are gone from the contract: launches
 * are owner-only and each one passes its own hard cap and wallet cap.
 *
 * Every panel here is the same shape: read the live value, take a new one, and
 * refuse to open the wallet for a value the contract would reject.  Those
 * refusals are named blockers rather than a `locked` boolean, so the button
 * says which guard is holding it and what would clear it.
 */

import { useState } from 'react'
import { useReadContract } from 'wagmi'
import type { Abi } from 'viem'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  MAX_POG_ALLOCATION_LIMIT,
  MAX_POG_ALLOCATION_LIMIT_LABEL,
  MAX_COOLDOWN_SECONDS,
  QUOTE_SYMBOL,
} from '@/lib/contracts'
import {
  ActionButton, useActionGate, useTxAction, revertOrder,
  type ActionBlocker,
} from '@/components/ui'
import {
  Section,
  ScopeNote,
  Field,
  Readout,
  fmtQuote,
  fmtDuration,
  parseEthInput,
} from './shared'

/**
 * The two blockers every numeric dial shares: nothing typed yet, and something
 * typed that is not a number.  Split because "fill the field in" and "that is
 * not a number" are different instructions.
 */
function amountBlockers(
  raw: string,
  parsed: ReturnType<typeof parseEthInput>,
  noun: string,
): readonly [ActionBlocker, ActionBlocker] {
  const empty = raw.trim() === ''
  return [
    {
      id: 'amount-missing',
      active: empty,
      label: `Enter a ${noun}`,
      reason: `Type the new ${noun} above.`,
      tone: 'neutral',
    },
    {
      id: 'amount-invalid',
      active: !empty && !parsed.ok,
      label: '[not_a_number]',
      reason: (!parsed.ok && parsed.reason) || 'That is not an amount this field can parse.',
    },
  ]
}

export function PogLimitPanel() {
  const [limitInput, setLimitInput] = useState('')

  const {
    data: currentLimitWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
  })

  const tx = useTxAction({ action: 'update the PoG ceiling', onConfirmed: () => { void refetch() } })
  const parsed = parseEthInput(limitInput)
  const zero = parsed.ok && parsed.value === 0n
  const aboveCeiling = parsed.ok && parsed.value > MAX_POG_ALLOCATION_LIMIT

  const gate = useActionGate({
    action: 'Update PoG ceiling',
    onAct: () => {
      if (!parsed.ok) return
      tx.send({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI as unknown as Abi,
        functionName: 'setMaxPogAllocationLimit',
        args: [parsed.value],
      })
    },
    tx,
    blockersInRevertOrder: revertOrder(
      ...amountBlockers(limitInput, parsed, 'ceiling'),
      {
        id: 'zero-pog-limit',
        active: zero,
        label: '[invalid_pog_limit]',
        reason: 'Zero is rejected on-chain: it would make every PoG attestation and every setPogQuota revert. Use the circuit breaker in G3 to stop taking on projects.',
      },
      {
        id: 'above-max-pog-limit',
        active: aboveCeiling,
        label: '[max_pog_limit_violation]',
        reason: `The factory reverts PogLimitTooHigh above MAX_POG_ALLOCATION_LIMIT (${MAX_POG_ALLOCATION_LIMIT_LABEL} ${QUOTE_SYMBOL}). This catches a wei/ether slip only; each round's own wallet cap is what bounds a single depositor.`,
      },
    ),
  })

  return (
    <Section
      id="G1-C" title="POG ALLOCATION CEILING"
      subtitle="setMaxPogAllocationLimit · caps the maxAlloc an oracle attestation (or setPogQuota) may grant · per-wallet deposit caps are now set per launch"
    >
      <Readout
        label="LIVE CEILING"
        value={isLoading && currentLimitWei === undefined ? 'reading…' : fmtQuote(currentLimitWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW CEILING · ${QUOTE_SYMBOL} · NON-ZERO · MAX ${MAX_POG_ALLOCATION_LIMIT_LABEL}`}
        value={limitInput}
        onChange={setLimitInput}
        // Was `e.g. 0.1`, left over from when this dial was BNB. It is BEM at
        // 46.4, so the hint was suggesting a figure three orders of magnitude
        // under the live value — on the field that sets the per-wallet cap.
        placeholder="e.g. 46.4"
        inputMode="decimal"
        disabled={tx.isBusy}
        errored={zero || aboveCeiling}
        fluo={parsed.ok && !zero && !aboveCeiling}
      />
      <ScopeNote>
        Forward-looking only. It bounds attestations signed from now on; PoG
        quotas already registered keep their granted allowance. Each round&apos;s
        per-wallet cap is chosen at createLaunch and baked into its hook, so
        this dial does not touch deployed projects at all.
        <br /><br />
        <span className="text-danger">
          Zero is not &ldquo;freeze registrations&rdquo;.
        </span>{' '}
        The factory rejects it outright — use the circuit breaker in G3 to stop
        taking on new projects, or the deposit freeze to stop a round.
        <br /><br />
        The {MAX_POG_ALLOCATION_LIMIT_LABEL} {QUOTE_SYMBOL} ceiling at the other end catches a
        wei/ether slip and nothing subtler. It is deliberately not an anti-whale
        bound; that job belongs to each round&apos;s wallet cap.
      </ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
}

export function DurationSetterPanel({
  id, title, subtitle, readoutLabel, buttonLabel,
  readFn, writeFn, zeroHint, zeroNote,
}: {
  id:           string
  title:        string
  subtitle:     string
  readoutLabel: string
  buttonLabel:  string
  readFn:       'cooldownDuration' | 'quotaWindowDuration'
  writeFn:      'setCooldownDuration' | 'setQuotaWindowDuration'
  zeroHint:     string
  zeroNote:     React.ReactNode
}) {
  const [secInput, setSecInput] = useState('')

  const {
    data: currentSec, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })

  const tx = useTxAction({ action: `set ${title.toLowerCase()}`, onConfirmed: () => { void refetch() } })

  const trimmed = secInput.trim()
  const parsed = /^\d+$/.test(trimmed)
    ? { ok: true as const, value: BigInt(trimmed) }
    : { ok: false as const }
  const overMax     = parsed.ok && parsed.value > BigInt(MAX_COOLDOWN_SECONDS)
  const settingZero = parsed.ok && parsed.value === 0n

  const gate = useActionGate({
    action: buttonLabel,
    onAct: () => {
      if (!parsed.ok) return
      tx.send({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI as unknown as Abi,
        functionName: writeFn,
        args: [parsed.value],
      })
    },
    tx,
    blockersInRevertOrder: revertOrder(
      {
        id: 'seconds-missing',
        active: trimmed === '',
        label: 'Enter a duration',
        reason: 'Type the new duration above, in whole seconds.',
        tone: 'neutral',
      },
      {
        id: 'seconds-invalid',
        active: trimmed !== '' && !parsed.ok,
        label: '[not_whole_seconds]',
        reason: 'Durations are whole seconds — no decimals, no units.',
      },
      {
        id: 'over-max-cooldown',
        active: overMax,
        label: '[above_max_cooldown]',
        reason: `The factory caps this at MAX_COOLDOWN (${MAX_COOLDOWN_SECONDS} s = 7 days) and would revert above it.`,
      },
    ),
  })

  return (
    <Section id={id} title={title} subtitle={subtitle}>
      <Readout
        label={readoutLabel}
        value={
          isLoading && currentSec === undefined
            ? 'reading…'
            : currentSec !== undefined
              ? <>{fmtDuration(currentSec as bigint, zeroHint)}{' '}
                  <span className="text-text-quiet">({(currentSec as bigint).toString()} s)</span></>
              : '—'
        }
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW VALUE · SECONDS · MAX ${MAX_COOLDOWN_SECONDS} (7 d)`}
        value={secInput}
        onChange={setSecInput}
        placeholder="e.g. 86400"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={tx.isBusy}
        errored={overMax}
        fluo={parsed.ok && !overMax}
      />
      <ScopeNote tone={settingZero ? 'warn' : 'mute'}>{zeroNote}</ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
}

export function CooldownDurationPanel() {
  return (
    <DurationSetterPanel
      id="G1-D"
      title="RE-DEPOSIT COOLDOWN"
      subtitle="setCooldownDuration · per-(wallet, hook) throttle between deposits"
      readoutLabel="LIVE COOLDOWN"
      buttonLabel="Set cooldown"
      readFn="cooldownDuration"
      writeFn="setCooldownDuration"
      zeroHint="0 (throttle disabled)"
      zeroNote={
        <>
          Setting 0 disables the re-deposit throttle only. It does NOT touch PoG
          quotas — the two knobs were deliberately split into separate storage
          slots precisely so a cool-off can be run without freezing allowances.
          The lifetime-budget behaviour lives on the quota window below.
        </>
      }
    />
  )
}

export function QuotaWindowPanel() {
  return (
    <DurationSetterPanel
      id="G1-E"
      title="POG QUOTA WINDOW"
      subtitle="setQuotaWindowDuration · how long a wallet's PoG spend ledger lasts before it refills"
      readoutLabel="LIVE WINDOW"
      buttonLabel="Set quota window"
      readFn="quotaWindowDuration"
      writeFn="setQuotaWindowDuration"
      zeroHint="0 (lifetime budget)"
      zeroNote={
        <>
          HIGH IMPACT · Setting 0 is a semantic shift, not an off switch: with no
          window to anchor a refill to, quotaSpent never resets and every
          wallet&apos;s PoG allowance degrades into a one-shot lifetime budget that
          can never be replenished.
        </>
      }
    />
  )
}
