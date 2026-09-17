'use client'

/**
 * G1 · FACTORY CONTROL — the five forward-looking dials on ToshFactory.
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
  MIN_SOFT_CAP_PROD,
  MIN_SOFT_CAP_PROD_LABEL,
  MAX_LAUNCH_FEE,
  MAX_LAUNCH_FEE_LABEL,
  MAX_DEFAULT_SOFT_CAP,
  MAX_DEFAULT_SOFT_CAP_LABEL,
  MAX_POG_ALLOCATION_LIMIT,
  MAX_POG_ALLOCATION_LIMIT_LABEL,
  MAX_COOLDOWN_SECONDS,
} from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
import {
  ActionButton, useActionGate, useTxAction, revertOrder,
  type ActionBlocker,
} from '@/components/ui'
import {
  Section,
  ScopeNote,
  Field,
  Readout,
  ConfirmDialog,
  fmtEth,
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

export function LaunchFeePanel() {
  const [feeInput, setFeeInput] = useState('')
  const [confirming, setConfirming] = useState(false)

  const {
    data: launchFeeWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee',
  })

  const tx = useTxAction({ action: 'update the launch fee', onConfirmed: () => { void refetch() } })
  const parsed = parseEthInput(feeInput)
  const aboveCeiling = parsed.ok && parsed.value > MAX_LAUNCH_FEE

  // Not wrapped in `useCallback`, like every other panel in this file. Reading
  // `parsed` for the ceiling check above left the React Compiler unable to
  // preserve the manual memoization, which made it skip optimizing the whole
  // component — a strictly worse trade than letting it memoize this itself.
  const submit = () => {
    setConfirming(false)
    if (!parsed.ok || aboveCeiling) return
    tx.send({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI as unknown as Abi,
      functionName: 'setLaunchFee',
      args: [parsed.value],
    })
  }

  const gate = useActionGate({
    action: 'Update launch fee',
    onAct: () => setConfirming(true),
    tx,
    blockersInRevertOrder: revertOrder(
      ...amountBlockers(feeInput, parsed, 'fee'),
      {
        id: 'above-max-launch-fee',
        active: aboveCeiling,
        label: '[max_launch_fee_violation]',
        reason: `The factory reverts LaunchFeeTooHigh above MAX_LAUNCH_FEE (${MAX_LAUNCH_FEE_LABEL} ${NATIVE_SYMBOL}). The ceiling exists to catch a wei/ether slip, which is exactly what this field is where you would make.`,
      },
    ),
  })

  return (
    <Section
      id="G1-A" title="LAUNCH FEE"
      subtitle={`setLaunchFee · native ${NATIVE_SYMBOL} charged on every createLaunch · anti-spam toll, forwarded to the ladder treasury · ceiling ${MAX_LAUNCH_FEE_LABEL} ${NATIVE_SYMBOL}`}
    >
      <Readout
        label="CURRENT FEE"
        value={isLoading && launchFeeWei === undefined ? 'reading…' : fmtEth(launchFeeWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW FEE · ${NATIVE_SYMBOL} · 0 ALLOWED · MAX ${MAX_LAUNCH_FEE_LABEL}`}
        value={feeInput}
        onChange={setFeeInput}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={tx.isBusy}
        errored={aboveCeiling}
        fluo={parsed.ok && !aboveCeiling}
      />
      <ScopeNote tone={aboveCeiling ? 'warn' : 'mute'}>
        A zero fee is legal and disables the anti-spam toll entirely. The change
        applies to the next createLaunch onward; launches already in flight paid
        the old fee and are unaffected. Above {MAX_LAUNCH_FEE_LABEL} {NATIVE_SYMBOL} the
        factory reverts LaunchFeeTooHigh, so this button stays inert rather than
        burning gas on a typo.
      </ScopeNote>

      <ActionButton gate={gate} full={false} />

      <ConfirmDialog
        open={confirming}
        title="Confirm launch-fee change"
        body={
          <>
            <p>
              {fmtEth(launchFeeWei as bigint | undefined)}
              {' → '}
              <span className="text-brand">
                {parsed.ok ? fmtEth(parsed.value) : '—'}
              </span>
            </p>
            <p className="mt-3 text-text-tertiary">
              Every createLaunch after this block must attach the new amount as
              msg.value. A UI still holding the old figure will revert.
            </p>
          </>
        }
        confirmLabel="commit fee"
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />
    </Section>
  )
}

export function SoftCapPanel() {
  const [capInput, setCapInput] = useState('')

  const {
    data: currentCapWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
  })

  const tx = useTxAction({ action: 'set the default soft cap', onConfirmed: () => { void refetch() } })
  const parsed = parseEthInput(capInput)
  const belowFloor = parsed.ok && parsed.value < MIN_SOFT_CAP_PROD
  const aboveCeiling = parsed.ok && parsed.value > MAX_DEFAULT_SOFT_CAP

  const gate = useActionGate({
    action: 'Set default cap',
    onAct: () => {
      if (!parsed.ok) return
      tx.send({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI as unknown as Abi,
        functionName: 'setDefaultSoftCap',
        args: [parsed.value],
      })
    },
    tx,
    blockersInRevertOrder: revertOrder(
      ...amountBlockers(capInput, parsed, 'cap'),
      {
        id: 'below-min-soft-cap',
        active: belowFloor,
        label: '[min_soft_cap_violation]',
        reason: `The factory reverts InvalidSoftCap below ${MIN_SOFT_CAP_PROD_LABEL} ${NATIVE_SYMBOL}, because a smaller raise rounds p0 toward zero against the 3.78 M genesis LP supply.`,
      },
      {
        id: 'above-max-soft-cap',
        active: aboveCeiling,
        label: '[max_soft_cap_violation]',
        reason: `The factory reverts SoftCapTooHigh above MAX_DEFAULT_SOFT_CAP (${MAX_DEFAULT_SOFT_CAP_LABEL} ${NATIVE_SYMBOL}). A raise that large is a wei/ether slip, not a decision — the cap is a progress target, not a launch gate, but a six-figure figure still means the dial was typed in wei.`,
      },
    ),
  })

  return (
    <Section
      id="G1-B" title="DEFAULT SOFT CAP"
      subtitle={`setDefaultSoftCap · frozen into every new hook's constructor · floor ${MIN_SOFT_CAP_PROD_LABEL} ${NATIVE_SYMBOL} · ceiling ${MAX_DEFAULT_SOFT_CAP_LABEL} ${NATIVE_SYMBOL}`}
    >
      <Readout
        label="LIVE CAP (NEXT LAUNCH)"
        value={isLoading && currentCapWei === undefined ? 'reading…' : fmtEth(currentCapWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW CAP · ${NATIVE_SYMBOL} · ${MIN_SOFT_CAP_PROD_LABEL} TO ${MAX_DEFAULT_SOFT_CAP_LABEL}`}
        value={capInput}
        onChange={setCapInput}
        placeholder="e.g. 10"
        inputMode="decimal"
        disabled={tx.isBusy}
        errored={belowFloor || aboveCeiling}
        fluo={parsed.ok && !belowFloor && !aboveCeiling}
      />
      <ScopeNote tone={belowFloor || aboveCeiling ? 'warn' : 'mute'}>
        {/* Was the literal "0.01 ETH", which survived the ×3.5 recalibration and
            so understated the live floor by 3.5×. Read off the same constant the
            blocker above reverts on, so the two cannot disagree again. */}
        The {MIN_SOFT_CAP_PROD_LABEL} {NATIVE_SYMBOL} floor is a price-truncation guard, not a business rule:
        p0 = lpNative × 1e18 / GENESIS_LP_SUPPLY, and with 3.78 M LP tokens a raise
        below the floor rounds p0 toward zero. The contract reverts InvalidSoftCap
        below it, so this button stays inert rather than burning gas.
        <br /><br />
        The {MAX_DEFAULT_SOFT_CAP_LABEL} {NATIVE_SYMBOL} ceiling catches the opposite slip and
        is deliberately far above any real raise. It is not a view on how much a
        project should ask for — the cap is a progress target, not a launch gate.
      </ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
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
        reason: 'Zero is rejected on-chain. This value is snapshotted into every new hook constructor, which requires a non-zero per-wallet cap, so a zero ceiling would make createLaunch revert for every creator. Use the circuit breaker in G3 to stop taking on projects.',
      },
      {
        id: 'above-max-pog-limit',
        active: aboveCeiling,
        label: '[max_pog_limit_violation]',
        reason: `The factory reverts PogLimitTooHigh above MAX_POG_ALLOCATION_LIMIT (${MAX_POG_ALLOCATION_LIMIT_LABEL} ${NATIVE_SYMBOL}). This catches a wei/ether slip only — it is not the point at which one wallet stops being able to take a whole round, and no constant can be, because the soft cap moves separately.`,
      },
    ),
  })

  return (
    <Section
      id="G1-C" title="POG ALLOCATION CEILING"
      subtitle="setMaxPogAllocationLimit · caps the maxAlloc an oracle attestation may grant, and is snapshotted as each new project's per-wallet deposit cap"
    >
      <Readout
        label="LIVE CEILING"
        value={isLoading && currentLimitWei === undefined ? 'reading…' : fmtEth(currentLimitWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW CEILING · ${NATIVE_SYMBOL} · NON-ZERO · MAX ${MAX_POG_ALLOCATION_LIMIT_LABEL}`}
        value={limitInput}
        onChange={setLimitInput}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={tx.isBusy}
        errored={zero || aboveCeiling}
        fluo={parsed.ok && !zero && !aboveCeiling}
      />
      <ScopeNote>
        Forward-looking only. Projects already deployed keep the per-wallet cap
        baked into their hook constructor, and PoG quotas already registered keep
        their granted allowance — a depositor&apos;s terms cannot be rewritten under
        them after they commit.
        <br /><br />
        <span className="text-danger">
          Zero is not &ldquo;freeze registrations&rdquo;.
        </span>{' '}
        This value is snapshotted into every new hook&apos;s constructor, which
        requires a non-zero per-wallet cap, so a zero ceiling made{' '}
        <code>createLaunch</code> revert for every creator platform-wide. The
        factory now rejects it outright — use the circuit breaker in G3 to stop
        taking on new projects.
        <br /><br />
        The {MAX_POG_ALLOCATION_LIMIT_LABEL} {NATIVE_SYMBOL} ceiling at the other end catches a
        wei/ether slip and nothing subtler. It is deliberately not an anti-whale
        bound: once this value reaches the soft cap, one wallet can fund an entire
        genesis round, and that ratio cannot be enforced here because the soft cap
        is a separate dial. Sizing it against the current cap stays your call.
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
