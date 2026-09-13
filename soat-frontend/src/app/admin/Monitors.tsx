'use client'


import { useState, useCallback, useEffect, useRef } from 'react'
import { useBytecode, useReadContract, useSignMessage } from 'wagmi'
import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'
import {
  ActionButton, useActionGate, revertOrder,
  toshToast, isUserRejection, shortErrorMessage,
} from '@/components/ui'
import { buildAdminConfigMessage, SIGNATURE_WINDOW_SEC } from '@/lib/adminConfigMessage'
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

/**
 * How long this panel gives itself to get the signature to the server.
 *
 * An injected wallet signs in one gesture, so this is generous already; the
 * `min` is there so that lowering `SIGNATURE_WINDOW_SEC.eoa` on the server can
 * never leave the panel asking for a window the server refuses — a mismatch that
 * would surface as a 400 about clocks.
 */
const CLIENT_TTL_SEC = Math.min(120, SIGNATURE_WINDOW_SEC.eoa)

export function ExchangeRatePanel() {
  const [rateInput, setRateInput] = useState('')
  const [busy, setBusy] = useState(false)

  const { signMessageAsync } = useSignMessage()

  // Whether this panel can work at all depends on what kind of address owns the
  // factory, so it has to ask. See the `owner-is-a-contract` blocker below.
  const { data: owner } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'owner',
  })
  const { data: ownerCode, isLoading: shapeLoading } = useBytecode({
    address: owner as `0x${string}` | undefined,
  })
  const ownerIsContract = Boolean(ownerCode && ownerCode !== '0x')

  const rate  = parseFloat(rateInput)
  const armed = !isNaN(rate) && rate > 0

  const handleUpdate = useCallback(async () => {
    if (!armed) return
    const nonce     = BigInt(Date.now())
    const expiresAt = Math.floor(Date.now() / 1000) + CLIENT_TTL_SEC
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
    blockersInRevertOrder: revertOrder(
      // First, because nothing the operator types can clear it. A contract owner
      // — the 2-of-3 Safe — cannot sign here: `providers.tsx` registers only
      // `injected()`, so the wallet behind `signMessageAsync` is always an
      // extension EOA, and the server checks the signature against the owner.
      // The request would be well-formed and 403 every time. Saying so beats
      // offering a button whose only outcome is that.
      {
        id: 'owner-is-a-contract',
        active: ownerIsContract,
        label: '[owner_is_a_safe]',
        reason:
          'The factory owner is a contract, and a browser wallet cannot sign for ' +
          'it. Rotate the rate with `node scripts/rotateGasRate.mjs` instead — it ' +
          'collects the two owner signatures off-line and submits them here.',
        tone: 'warn',
      },
      {
        id: 'owner-shape-unknown',
        active: !ownerIsContract && shapeLoading,
        label: 'Checking owner…',
        reason: 'Reading whether the factory owner is an EOA or a contract.',
        tone: 'neutral',
      },
      {
        id: 'rate-invalid',
        active: !armed,
        label: rateInput.trim() === '' ? 'Enter a rate' : '[not_a_positive_number]',
        reason: rateInput.trim() === ''
          ? 'Type the new quota-per-gas rate above.'
          : 'The rate must be a positive number.',
        tone: rateInput.trim() === '' ? 'neutral' : 'danger',
      },
    ),
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
        {ownerIsContract && (
          <>
            {' '}The owner here is a contract, so this panel is read-only in
            practice: use <code>scripts/rotateGasRate.mjs</code>, which asks the
            Safe owners for signatures and posts the assembled result.
          </>
        )}
      </ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
}
