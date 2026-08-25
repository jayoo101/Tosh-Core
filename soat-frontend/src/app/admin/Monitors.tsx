'use client'


import { useState, useCallback, useEffect, useRef } from 'react'
import { useReadContract, useSignMessage } from 'wagmi'
import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'
import {
  ActionButton, useActionGate, revertOrder,
  toshToast, isUserRejection, shortErrorMessage,
} from '@/components/ui'
import { Section, ScopeNote, Field } from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS  ·  live initcode hash + off-chain rate
// ─────────────────────────────────────────────────────────────────────────────

export function InitcodeHashMonitor() {
  const {
    data: liveHash, isLoading, isFetching, error: readError,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'getLiveHookInitcodeHash',
    query: { refetchInterval: 8_000, refetchOnWindowFocus: true },
  })

  const prevHashRef = useRef<string | null>(null)
  const [rotated, setRotated] = useState(false)
  useEffect(() => {
    if (typeof liveHash !== 'string') return
    if (prevHashRef.current === null) { prevHashRef.current = liveHash; return }
    if (prevHashRef.current !== liveHash) {
      prevHashRef.current = liveHash
      setRotated(true)
      const id = setTimeout(() => setRotated(false), 4000)
      return () => clearTimeout(id)
    }
  }, [liveHash])

  const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const hashOk = typeof liveHash === 'string'
    && liveHash.startsWith('0x')
    && liveHash.toLowerCase() !== ZERO_HASH

  const display = isLoading || liveHash === undefined
    ? 'reading…'
    : hashOk ? (liveHash as string) : ZERO_HASH

  const statusLine = readError || (!isLoading && !hashOk)
    ? <span className="text-text-tertiary">OFFLINE</span>
    : rotated
      ? <span className="text-brand">ROTATED</span>
      : <span className="text-brand">OK</span>

  return (
    <Section
      id="DIAG-A" title="LIVE INITCODE HASH"
      subtitle="factory.getLiveHookInitcodeHash() · build fingerprint · 8 s probe"
    >
      <p className="font-mono text-note text-text-tertiary tracking-wider break-all leading-relaxed">
        hash{'  '}<span className="text-text-secondary">{display}</span>
      </p>
      <p className="font-mono text-label tracking-[0.32em] uppercase flex items-center gap-3">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${hashOk ? 'bg-brand' : 'bg-surface-hover'}`} aria-hidden />
        {statusLine}
        {isFetching && !isLoading && <span className="text-text-quiet">· syncing</span>}
      </p>
      <ScopeNote>
        Sentinel-address hash — a fingerprint, not a mining target. It changes iff
        the hook creation code or the factory wiring changed, which is the signal
        that every previously mined salt is now dead. Mine against
        factory.hookInitcodeHash(...) with the creator&apos;s real arguments.
      </ScopeNote>
    </Section>
  )
}

export function buildAdminConfigMessage(rate: number, nonce: bigint, expiresAt: number): string {
  return (
    `Tosh Admin Config Update\n` +
    `rate:      ${rate}\n` +
    `nonce:     ${nonce.toString()}\n` +
    `expiresAt: ${expiresAt}`
  )
}

export function ExchangeRatePanel() {
  const [rateInput, setRateInput] = useState('')
  const [busy, setBusy] = useState(false)

  const { signMessageAsync } = useSignMessage()

  const rate  = parseFloat(rateInput)
  const armed = !isNaN(rate) && rate > 0

  const handleUpdate = useCallback(async () => {
    if (!armed) return
    const nonce     = BigInt(Date.now())
    const expiresAt = Math.floor(Date.now() / 1000) + 120
    const msg       = buildAdminConfigMessage(rate, nonce, expiresAt)

    setBusy(true)
    try {
      const signature = await signMessageAsync({ message: msg })
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRate: rate, nonce: nonce.toString(), expiresAt, signature }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      toshToast.success(
        `Rate updated — ${data.previous} → ${data.globalGasToSatoRate} (${data.authMethod})`,
      )
    } catch (err) {
      if (!isUserRejection(err)) {
        toshToast.error(shortErrorMessage(err) ?? 'Could not update the rate.')
      }
    } finally {
      setBusy(false)
    }
  }, [armed, rate, signMessageAsync])

  // A signed instruction to our own backend, so no chain is involved — but the
  // ambient owner gate still is, which is why this goes through the gate at all.
  const gate = useActionGate({
    action: 'Update rate',
    onAct: () => { void handleUpdate() },
    tx: { isBusy: busy },
    requiresNetwork: false,
    blockersInRevertOrder: revertOrder({
      id: 'rate-invalid',
      active: !armed,
      label: rateInput.trim() === '' ? 'Enter a rate' : '[not_a_positive_number]',
      reason: rateInput.trim() === ''
        ? 'Type the new quota-per-gas rate above.'
        : 'The rate must be a positive number.',
      tone: rateInput.trim() === '' ? 'neutral' : 'danger',
    }),
  })

  return (
    <Section
      id="DIAG-B" title="POG EXCHANGE RATE (OFF-CHAIN)"
      subtitle="POST /api/admin/config · owner-signed message, not a transaction · 1 ETH gas = N ETH quota"
    >
      <Field
        label="NEW RATE · ETH QUOTA PER 1 ETH GAS"
        value={rateInput}
        onChange={setRateInput}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={busy}
        fluo={armed}
      />
      <ScopeNote>
        This one never touches the chain. It is an owner-signed instruction to the
        backend, so it costs no gas and leaves no on-chain trace — and it is only
        as trustworthy as the API server holding the other end.
      </ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
}
