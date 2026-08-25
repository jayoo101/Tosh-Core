'use client'


import { useState, useCallback, useEffect } from 'react'
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  TARGET_CHAIN_ID,
  MIN_SOFT_CAP_PROD,
  MIN_SOFT_CAP_PROD_LABEL,
  MAX_COOLDOWN_SECONDS,
} from '@/lib/contracts'
import {
  Section,
  ScopeNote,
  Field,
  WriteButton,
  Readout,
  AlarmLine,
  TxLine,
  ConfirmDialog,
  fmtEth,
  fmtDuration,
  parseEthInput,
  shortErr,
} from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G1 · FACTORY CONTROL
// ─────────────────────────────────────────────────────────────────────────────

export function LaunchFeePanel() {
  const [feeInput, setFeeInput] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const {
    data: launchFeeWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee',
  })

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = parseEthInput(feeInput)
  const txBusy = isPending || isConfirming

  const submit = useCallback(() => {
    setConfirming(false)
    if (!parsed.ok) { setError(parsed.reason ?? 'Invalid number format'); return }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setLaunchFee', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

  return (
    <Section
      id="G1-A" title="LAUNCH FEE"
      subtitle="setLaunchFee · native ETH charged on every createLaunch · anti-spam toll, forwarded to the ladder treasury"
    >
      <Readout
        label="CURRENT FEE"
        value={isLoading && launchFeeWei === undefined ? 'reading…' : fmtEth(launchFeeWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label="NEW FEE · ETH · 0 ALLOWED"
        value={feeInput}
        onChange={v => { setFeeInput(v); setError(null) }}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={txBusy}
        fluo={parsed.ok}
      />
      <ScopeNote>
        A zero fee is legal and disables the anti-spam toll entirely. The change
        applies to the next createLaunch onward; launches already in flight paid
        the old fee and are unaffected.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="update launch fee"
          onClick={() => { setError(null); if (parsed.ok) setConfirming(true) }}
          locked={!parsed.ok}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setLaunchFee" />

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
  const [error, setError]       = useState<string | null>(null)

  const {
    data: currentCapWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed     = parseEthInput(capInput)
  const belowFloor = parsed.ok && parsed.value < MIN_SOFT_CAP_PROD
  const txBusy     = isPending || isConfirming

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError(parsed.reason ?? 'Enter a valid ETH amount'); return }
    if (parsed.value < MIN_SOFT_CAP_PROD) return
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setDefaultSoftCap', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

  return (
    <Section
      id="G1-B" title="DEFAULT SOFT CAP"
      subtitle={`setDefaultSoftCap · frozen into every new hook's constructor · floor ${MIN_SOFT_CAP_PROD_LABEL} ETH`}
    >
      <Readout
        label="LIVE CAP (NEXT LAUNCH)"
        value={isLoading && currentCapWei === undefined ? 'reading…' : fmtEth(currentCapWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW CAP · ETH ≥ ${MIN_SOFT_CAP_PROD_LABEL}`}
        value={capInput}
        onChange={v => { setCapInput(v); setError(null) }}
        placeholder="e.g. 10"
        inputMode="decimal"
        disabled={txBusy}
        errored={belowFloor}
        fluo={parsed.ok && !belowFloor}
      />
      {belowFloor && (
        <p className="font-mono text-label tracking-[0.32em] text-brand uppercase">
          → GUARD LOCKED · MIN_SOFT_CAP_VIOLATION
        </p>
      )}
      <ScopeNote tone={belowFloor ? 'warn' : 'mute'}>
        The 0.01 ETH floor is a price-truncation guard, not a business rule:
        p0 = lpEth × 1e18 / GENESIS_LP_SUPPLY, and with 3.78 M LP tokens a raise
        below the floor rounds p0 toward zero. The contract reverts InvalidSoftCap
        below it, so this button stays inert rather than burning gas.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="set default cap"
          onClick={handleSet}
          locked={!parsed.ok || belowFloor}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setDefaultSoftCap" />
    </Section>
  )
}

export function PogLimitPanel() {
  const [limitInput, setLimitInput] = useState('')
  const [error, setError]           = useState<string | null>(null)

  const {
    data: currentLimitWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = parseEthInput(limitInput)
  const txBusy = isPending || isConfirming

  const zero = parsed.ok && parsed.value === 0n

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError(parsed.reason ?? 'Invalid number format'); return }
    if (parsed.value === 0n) {
      setError('Zero is rejected on-chain (InvalidPogLimit). It is snapshotted into every new hook constructor, which requires a non-zero per-wallet cap — at zero createLaunch reverts for every creator. Use PAUSE to stop taking on projects.')
      return
    }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setMaxPogAllocationLimit', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

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
        label="NEW CEILING · ETH · MUST BE NON-ZERO"
        value={limitInput}
        onChange={v => { setLimitInput(v); setError(null) }}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={txBusy}
        fluo={parsed.ok && !zero}
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
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="update pog ceiling"
          onClick={handleSet}
          locked={!parsed.ok || zero}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setMaxPogAllocationLimit" />
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
  const [error, setError]       = useState<string | null>(null)

  const {
    data: currentSec, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = (() => {
    const trimmed = secInput.trim()
    if (!trimmed) return { ok: false as const }
    if (!/^\d+$/.test(trimmed)) return { ok: false as const }
    return { ok: true as const, value: BigInt(trimmed) }
  })()
  const overMax    = parsed.ok && parsed.value > BigInt(MAX_COOLDOWN_SECONDS)
  const settingZero = parsed.ok && parsed.value === 0n
  const txBusy     = isPending || isConfirming

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError('Enter a non-negative integer (seconds)'); return }
    if (parsed.value > BigInt(MAX_COOLDOWN_SECONDS)) {
      setError(`Exceeds MAX_COOLDOWN (${MAX_COOLDOWN_SECONDS} s = 7 d) — would revert.`)
      return
    }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: writeFn, args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract, writeFn])

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
        onChange={v => { setSecInput(v); setError(null) }}
        placeholder="e.g. 86400"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={txBusy}
        errored={overMax}
        fluo={parsed.ok && !overMax}
        hint={overMax
          ? <span className="text-danger">→ ABOVE_MAX_COOLDOWN (WOULD_REVERT)</span>
          : null}
      />
      <ScopeNote tone={settingZero ? 'warn' : 'mute'}>{zeroNote}</ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={buttonLabel}
          onClick={handleSet}
          locked={!parsed.ok || overMax}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={writeFn} />
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
      buttonLabel="set cooldown"
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
      buttonLabel="set quota window"
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
