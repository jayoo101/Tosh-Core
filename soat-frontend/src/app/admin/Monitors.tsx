'use client'


import { useState, useCallback, useEffect, useRef } from 'react'
import { useBytecode, useReadContract, useSignMessage } from 'wagmi'
import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
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

/** What `GET /api/admin/config` reports about the live band. */
interface LiveBand {
  globalGasToSatoRate: number
  pogFloorWei: string
  pogMaxAllocWei: string
  pogGasCapWei: string
  rateStore: 'memory' | 'redis'
}

const weiToEth = (wei: string) => {
  try {
    // Trimmed rather than fixed-width: these are round numbers in practice and
    // `0.025` reads as a decision where `0.025000000000000000` reads as noise.
    return (Number(BigInt(wei)) / 1e18).toString()
  } catch {
    return '?'
  }
}

export function ExchangeRatePanel() {
  const [rateInput, setRateInput] = useState('')
  const [busy, setBusy] = useState(false)

  // The three dials, as the server sees them. Shown because two of them can
  // only be moved from the CLI: without a read-out, an operator has no way to
  // tell whether a rotation landed except by signing another one.
  const [live, setLive] = useState<LiveBand | null>(null)
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const res = await fetch('/api/admin/config', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as LiveBand
        if (alive) setLive(data)
      } catch { /* a read-out that cannot read stays blank rather than lying */ }
    }
    void read()
    const id = setInterval(read, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

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
    // Rate only. The floor and the ceiling sign as `keep`, which is a statement
    // about them rather than their absence — this panel deliberately does not
    // offer them, because a per-wallet deposit cap typed into a box with no
    // second pair of eyes is what `scripts/rotateGasRate.mjs` exists to avoid.
    const msg       = buildAdminConfigMessage({ rate, nonce, expiresAt })

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
      id="DIAG-B" title="POG BAND (OFF-CHAIN)"
      subtitle={`POST /api/admin/config · owner-signed message, not a transaction · 1 ETH gas = N ${NATIVE_SYMBOL} quota`}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-note @sm:grid-cols-2">
        {/* THE TWO UNITS IN THIS LIST ARE NOT THE SAME COIN, and the rows are
            ordered so that is visible. `pogFloorWei` and `pogGasCapWei` measure
            gas burned on ETH-settled chains and stay ETH; `pogMaxAllocWei` is
            what the wallet may then deposit, so it follows the settlement chain.
            The rate carries the conversion and is therefore per-ETH-of-gas, not
            dimensionless — see the currency note at the top of `pogQuota.ts`. */}
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Rate</dt>
          <dd>{live ? `${live.globalGasToSatoRate} ${NATIVE_SYMBOL} per 1 ETH gas` : 'reading…'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Gas floor</dt>
          <dd>{live ? `${weiToEth(live.pogFloorWei)} ETH` : 'reading…'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Max deposit</dt>
          <dd>{live ? `${weiToEth(live.pogMaxAllocWei)} ${NATIVE_SYMBOL}` : 'reading…'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Counts gas up to</dt>
          <dd>{live ? `${weiToEth(live.pogGasCapWei)} ETH` : 'reading…'}</dd>
        </div>
      </dl>

      <Field
        label={`NEW RATE · ${NATIVE_SYMBOL} QUOTA PER 1 ETH GAS`}
        value={rateInput}
        onChange={setRateInput}
        placeholder="e.g. 0.5"
        inputMode="decimal"
        disabled={busy}
        fluo={armed}
      />
      <ScopeNote tone={live?.rateStore === 'memory' ? 'warn' : 'mute'}>
        This one never touches the chain. It is an owner-signed instruction to the
        backend, so it costs no gas and leaves no on-chain trace — and it is only
        as trustworthy as the API server holding the other end.
        {live?.rateStore === 'memory' && (
          <>
            {' '}The band is held per-instance right now (<code>rateStore: memory</code>),
            so a rotation lands on whichever server answered the POST and every other
            one keeps signing at the old numbers. Set the Upstash variables before
            turning any of these dials.
          </>
        )}
        <br /><br />
        Only the rate is typed here. The gas floor and the max-deposit ceiling move
        through <code>scripts/rotateGasRate.mjs request --rate N --floor N --max-alloc N</code>,
        because the ceiling is also the per-wallet deposit cap and raising it needs
        the on-chain <code>setMaxPogAllocationLimit</code> to move first — the
        endpoint refuses a ceiling above the live factory dial.
        {ownerIsContract && (
          <>
            {' '}The owner here is a contract, so this panel is read-only in
            practice: use that script for the rate too — it asks the Safe owners
            for signatures and posts the assembled result.
          </>
        )}
      </ScopeNote>

      <ActionButton gate={gate} full={false} />
    </Section>
  )
}
