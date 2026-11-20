'use client'

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, Copy, Gift, Info, Link2, Shuffle } from 'lucide-react'
import { parseAbi, parseUnits } from 'viem'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'

import { Panel } from '@/components/x/Panel'
import { AddressLink, Button, useIsHydrated } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { AUTOPAY_LIMITS } from '@/lib/ouroboros/autopayPlan'
import { OURO_REF_PAYER, OURO_TREASURY } from '@/lib/ouroboros/config'
import {
  MAX_REF_BONUS_WEI, randomRefCode, REF_CODE_RE, REF_READ_SIG_TTL_MS, refMessage, type RefAction,
} from '@/lib/ouroboros/ref'

import { Field } from './Field'
import { fmt } from './fmt'
import { usePartnersCopy } from './partnersCopy'

const SAFE_ABI = parseAbi(['function isOwner(address owner) view returns (bool)'])
/** Set only where the admin API is enabled (`OURO_REF_ADMIN`), i.e. a signer's local run. */
const ADMIN_ENABLED = process.env.NEXT_PUBLIC_OURO_REF_ADMIN === '1'

interface Application {
  id: number; code: string; partner: string; label: string
  status: 'pending' | 'approved' | 'rejected'
  appliedAt: string; reviewedAt: string | null; rejectReason: string | null
}

interface Report {
  links: { code: string; partner: string; label: string; bonus: string | null; accounts: number; volume: string; accrued: string }[]
  payouts: { txHash: string; logIndex: number; partner: string; amount: string; blockNumber: number }[]
  partners: { partner: string; accrued: string; paid: string; owed: string }[]
  applications: Application[]
}

interface Autopay { enabled: boolean; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null }

const noopSubscribe = () => () => {}

/** Read-only signatures are remembered per wallet until shortly before the server stops accepting them. */
const sigKey = (address: string, req: RefAction) => `ouro:refsig:${address.toLowerCase()}:${req.action}`
const isRead = (req: RefAction) => req.action === 'list' || req.action === 'view'

function readCachedSig(address: string, req: RefAction): { issuedAt: number; signature: `0x${string}` } | null {
  if (!isRead(req)) return null
  try {
    const raw = window.localStorage.getItem(sigKey(address, req))
    if (!raw) return null
    const v = JSON.parse(raw) as { issuedAt: number; signature: `0x${string}` }
    return Date.now() - v.issuedAt < REF_READ_SIG_TTL_MS - 5 * 60_000 ? v : null
  } catch {
    return null
  }
}

function writeCachedSig(address: string, req: RefAction, issuedAt: number, signature: string) {
  if (!isRead(req)) return
  try { window.localStorage.setItem(sigKey(address, req), JSON.stringify({ issuedAt, signature })) } catch { /* storage blocked */ }
}

function clearCachedSig(address: string, req: RefAction) {
  try { window.localStorage.removeItem(sigKey(address, req)) } catch { /* storage blocked */ }
}
const usdt = (wei: string) => `${fmt(BigInt(wei), 2)} USDT`
/** A USDT amount typed by the admin, as wei; undefined unless it is above 0 and at most the cap. */
const toWei = (s: string) => {
  const t = s.trim()
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return undefined
  const wei = parseUnits(t, 18)
  return wei > 0n && wei <= MAX_REF_BONUS_WEI ? wei.toString() : undefined
}

export function PartnersApp() {
  const c = usePartnersCopy()
  const picker = useWalletPicker()
  const hydrated = useIsHydrated()
  const { address, status } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const signer = useReadContract({
    address: OURO_TREASURY, abi: SAFE_ABI, functionName: 'isOwner', args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID, query: { enabled: ADMIN_ENABLED && OURO_TREASURY !== undefined && address !== undefined },
  })
  const isAdmin = ADMIN_ENABLED && signer.data === true
  // Wait for wagmi to finish reconnecting before choosing Connect vs Sign,
  // otherwise the button flips every time the connector briefly goes idle.
  const walletReady = hydrated && status !== 'connecting' && status !== 'reconnecting'

  // Kept with the wallet that signed for it, and shown only while that wallet
  // is connected: switching wallets must not leave an admin listing on screen.
  const [fetched, setFetched] = useState<{ by: string; report: Report; autopay: Autopay | null } | null>(null)
  const report = fetched && fetched.by === address ? fetched.report : null
  const autopay = fetched && fetched.by === address ? fetched.autopay : null
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const readAction: RefAction = { action: isAdmin ? 'list' : 'view' }
  const roleKnown = !ADMIN_ENABLED || signer.data !== undefined

  const run = async (request: RefAction, opts: { cachedOnly?: boolean } = {}) => {
    if (!address) return
    const cached = readCachedSig(address, request)
    if (opts.cachedOnly && !cached) return
    setBusy(true)
    setMessage(null)
    try {
      const { issuedAt, signature } = cached ?? await (async () => {
        const at = Date.now()
        return { issuedAt: at, signature: await signMessageAsync({ message: refMessage(request, at) }) }
      })()
      const res = await fetch('/api/ouroboros/ref', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, issuedAt, address, signature }),
      })
      const body = await res.json()
      if (!res.ok) {
        if (cached) clearCachedSig(address, request)
        throw new Error(body.error ?? res.statusText)
      }
      if (!cached) writeCachedSig(address, request, issuedAt, signature)
      setFetched({ by: address, report: body.report, autopay: body.autopay ?? null })
      if (typeof body.recorded === 'number') setMessage(c.recorded(body.recorded))
      if (request.action === 'apply') setMessage(c.applyOk)
      return true
    } catch (err) {
      if (!opts.cachedOnly) setMessage(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Reload the listing from a remembered read signature, so a refresh does not
  // ask the wallet again.
  const autoKey = walletReady && address && roleKnown && !report ? `${address}:${readAction.action}` : null
  useEffect(() => {
    if (!autoKey) return
    const t = window.setTimeout(() => void run(readAction, { cachedOnly: true }), 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on wallet + role only
  }, [autoKey])

  const connectButton = !walletReady
    ? <Button label={c.connect} full disabled />
    : <Button label={c.connect} full onClick={() => picker?.open()} />

  return (
    <div className="flex flex-col gap-6">
      <header className="glow-frame glow-flow relative isolate overflow-hidden rounded-panel bg-surface-card/85">
        <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="flex flex-col gap-8 p-6 md:p-10">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="flex w-fit items-center gap-2 rounded-pill border border-brand/40 bg-brand/10 px-3 py-1 font-mono text-label uppercase text-brand">
              <Gift className="size-3.5" aria-hidden />
              {c.kicker}
            </span>
            <h1 className="font-mono text-3xl font-bold tracking-tight text-text-primary md:text-4xl">{c.title}</h1>
            <p className="text-pretty text-note text-text-secondary md:text-body">{c.intro}</p>
          </div>
          <ol className="grid gap-3 md:grid-cols-3">
            {c.steps.map(([title, body], i) => (
              <li key={title} className="flex gap-3 rounded-card border border-border-subtle bg-bg-base/60 p-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-pill border border-brand/40 bg-brand/10 font-mono text-label font-bold text-brand">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-note font-bold text-text-primary">{title}</span>
                  <span className="text-note text-text-tertiary">{body}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <ApplyForm busy={busy} run={run} connected={walletReady && !!address} connectButton={connectButton} />

        <Panel title={isAdmin ? c.adminTitle : c.recordsTitle}>
          <div className="flex flex-col gap-4">
            <p className="text-note text-text-secondary">
              {walletReady && address && (!ADMIN_ENABLED || signer.data !== undefined)
                ? (isAdmin ? c.adminRole : c.partnerRole)
                : c.recordsNote}
            </p>
            {walletReady && address && (() => {
              const remembered = readCachedSig(address, readAction) !== null
              return (
                <>
                  <Button
                    label={busy ? (remembered ? c.loading : c.signing) : (remembered ? c.refresh : c.sign)}
                    full
                    variant={remembered ? 'ghost' : 'primary'}
                    onClick={() => void run(readAction)}
                    disabled={busy || !roleKnown}
                  />
                  <p className="text-label text-text-quiet">{remembered ? c.signRemembered : c.signOnce}</p>
                </>
              )
            })()}
            {message && (
              <p className="rounded-input border border-border-subtle bg-bg-subtle px-3 py-2 text-note text-text-secondary">
                {message}
              </p>
            )}
          </div>
        </Panel>
      </div>

      {report && (
        <>
          <Applications report={report} admin={isAdmin} busy={busy} run={run} />
          <Links report={report} admin={isAdmin} busy={busy} run={run} />
          {isAdmin && autopay && <AutopayPanel report={report} autopay={autopay} busy={busy} run={run} />}
          <Balances report={report} />
          {isAdmin && <AdminForms busy={busy} run={run} />}
          <Payouts report={report} />
        </>
      )}
    </div>
  )
}

type Run = (request: RefAction) => Promise<boolean | undefined>

function ApplyForm({ busy, run, connected, connectButton }: {
  busy: boolean; run: Run; connected: boolean; connectButton: ReactNode
}) {
  const c = usePartnersCopy()
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState(false)
  const [liveCode, setLiveCode] = useState<string | null>(null)
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => '')
  const normalized = code.trim().toLowerCase()
  const inviteUrl = origin !== '' && REF_CODE_RE.test(normalized)
    ? `${origin}/ouroboros?ref=${normalized}`
    : null
  const live = inviteUrl !== null && liveCode === normalized

  useEffect(() => {
    if (!inviteUrl) return
    let cancelled = false
    void fetch(`/api/ouroboros/ref/check?code=${normalized}`)
      .then(r => r.ok ? r.json() : null)
      .then((body: { registered?: boolean } | null) => {
        if (!cancelled && body?.registered) setLiveCode(normalized)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [inviteUrl, normalized])

  const codeInvalid = normalized !== '' && !REF_CODE_RE.test(normalized)
  const copy = () => {
    if (!inviteUrl) return
    void navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Panel title={c.applyTitle}>
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="flex items-center justify-between text-note text-text-secondary">
            {c.code}
            <span className={`font-mono text-label ${codeInvalid ? 'text-danger' : 'text-text-quiet'}`}>{c.codeHint}</span>
          </span>
          <div
            className="flex h-12 items-stretch overflow-hidden rounded-input border border-border-subtle bg-bg-subtle transition-colors focus-within:border-brand"
          >
            <span className="flex items-center border-r border-border-subtle px-3 font-mono text-note text-text-quiet">?ref=</span>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16))}
              placeholder={c.codePlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-3 font-mono text-body text-text-primary outline-none placeholder:text-text-quiet"
            />
            <button
              type="button"
              onClick={() => setCode(randomRefCode())}
              disabled={busy}
              className="flex items-center gap-1.5 border-l border-border-subtle px-4 font-mono text-label font-bold uppercase text-brand transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:text-text-quiet"
            >
              <Shuffle className="size-3.5" aria-hidden />
              {c.randomCode}
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-2">
          <span className="flex items-center justify-between text-note text-text-secondary">
            {c.label}
            <span className="font-mono text-label text-text-quiet">{label.length}/64</span>
          </span>
          <input
            value={label}
            onChange={e => setLabel(e.target.value.slice(0, 64))}
            placeholder={c.labelPlaceholder}
            className="h-12 rounded-input border border-border-subtle bg-bg-subtle px-3 text-body text-text-primary outline-none transition-colors placeholder:text-text-quiet focus:border-brand"
          />
        </label>

        <div
          className={`flex flex-col gap-3 rounded-card border p-4 transition-colors ${inviteUrl ? 'border-brand/30 bg-brand/5' : 'border-dashed border-border-subtle bg-bg-base/40'}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-label uppercase text-text-tertiary">
              <Link2 className="size-3.5" aria-hidden />
              {c.url}
            </span>
            {inviteUrl && (
              <span className={`rounded-pill border px-2 py-0.5 text-label ${live ? 'border-brand/40 bg-brand/10 text-brand' : 'border-border-subtle text-text-tertiary'}`}>
                {live ? c.linkLive : c.linkPending}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <code className={`min-w-0 flex-1 truncate font-mono text-note ${inviteUrl ? 'text-text-primary' : 'text-text-quiet'}`}>
              {inviteUrl ?? c.urlPlaceholder}
            </code>
            {inviteUrl && (
              <button
                type="button"
                onClick={copy}
                className="flex shrink-0 items-center gap-1.5 rounded-input border border-border-subtle px-3 py-1.5 font-mono text-label font-bold uppercase text-text-secondary transition-colors hover:border-brand hover:text-brand"
              >
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                {copied ? c.copied : c.copy}
              </button>
            )}
          </div>
        </div>

        {connected ? (
          <Button
            label={busy ? c.signing : c.applySubmit}
            size="lg"
            full
            onClick={() => void run({ action: 'apply', code: normalized, label: label.trim() })}
            disabled={busy || !inviteUrl}
          />
        ) : connectButton}
        <p className="flex gap-2 text-note text-text-tertiary">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {c.applyNote}
        </p>
      </div>
    </Panel>
  )
}

function Applications({ report, admin, busy, run }: { report: Report; admin: boolean; busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [reasons, setReasons] = useState<Record<number, string>>({})
  const [bonuses, setBonuses] = useState<Record<number, string>>({})
  const apps = report.applications
  const title = admin ? c.applications : c.myApplications
  if (apps.length === 0) {
    return admin
      ? <Panel title={title}><p className="text-note text-text-tertiary">{c.noApplications}</p></Panel>
      : null
  }
  return (
    <Panel title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-note">
          <thead className="text-label uppercase text-text-tertiary">
            <tr>
              <th className="px-3 py-2">{c.code}</th>
              {admin && <th className="px-3 py-2">{c.partner}</th>}
              <th className="px-3 py-2">{c.label}</th>
              <th className="px-3 py-2">{c.appState}</th>
              {admin && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {apps.map(a => {
              const bonusInput = bonuses[a.id] ?? '5'
              const wei = toWei(bonusInput)
              return (
              <tr key={a.id} className="border-t border-border-subtle">
                <td className="px-3 py-2 font-mono">{a.code}</td>
                {admin && <td className="px-3 py-2 font-mono"><AddressLink value={a.partner} /></td>}
                <td className="px-3 py-2">{a.label || '—'}</td>
                <td className="px-3 py-2">
                  {c.appStatus[a.status]}
                  {a.status === 'rejected' && a.rejectReason ? ` · ${a.rejectReason}` : ''}
                </td>
                {admin && a.status === 'pending' && (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        inputMode="decimal"
                        aria-label={c.approveBonus}
                        placeholder={c.approveBonus}
                        value={bonusInput}
                        onChange={e => setBonuses({ ...bonuses, [a.id]: e.target.value })}
                        className="w-24 rounded-input border border-border-subtle bg-bg-subtle px-2 py-1 font-mono text-text-primary"
                      />
                      <Button
                        label={c.approveApp} size="sm" disabled={busy || wei === undefined}
                        onClick={() => wei !== undefined && void run({
                          action: 'approveApplication', id: a.id, bonus: wei,
                        })}
                      />
                      <input
                        placeholder={c.rejectReason} value={reasons[a.id] ?? ''}
                        onChange={e => setReasons({ ...reasons, [a.id]: e.target.value })}
                        className="w-40 rounded-input border border-border-subtle bg-bg-subtle px-2 py-1 text-text-primary"
                      />
                      <Button
                        label={c.rejectApp} size="sm" variant="ghost" disabled={busy}
                        onClick={() => void run({ action: 'rejectApplication', id: a.id, reason: reasons[a.id] ?? '' })}
                      />
                    </div>
                  </td>
                )}
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Links({ report, admin, busy, run }: { report: Report; admin: boolean; busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [copied, setCopied] = useState<string | null>(null)
  const [bonuses, setBonuses] = useState<Record<string, string>>({})
  const url = (code: string) => `${window.location.origin}/ouroboros?ref=${code}`
  if (report.links.length === 0) return <Panel title={c.links}><p className="text-note text-text-tertiary">{c.noLinks}</p></Panel>
  return (
    <Panel title={c.links}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-note">
          <thead className="text-label uppercase text-text-tertiary">
            <tr>
              <th className="px-3 py-2">{c.code}</th>
              {admin && <th className="px-3 py-2">{c.partner}</th>}
              <th className="px-3 py-2">{c.label}</th>
              <th className="px-3 py-2">{c.bonus}</th>
              <th className="px-3 py-2">{c.accounts}</th>
              <th className="px-3 py-2">{c.volume}</th>
              <th className="px-3 py-2">{c.accrued}</th>
              <th className="px-3 py-2">{c.url}</th>
              {admin && <th className="px-3 py-2">{c.setBonus}</th>}
            </tr>
          </thead>
          <tbody>
            {report.links.map(l => {
              const wei = toWei(bonuses[l.code] ?? '')
              return (
                <tr key={l.code} className="border-t border-border-subtle">
                  <td className="px-3 py-2 font-mono">{l.code}</td>
                  {admin && <td className="px-3 py-2 font-mono"><AddressLink value={l.partner} /></td>}
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 font-mono">{l.bonus ? usdt(l.bonus) : '—'}</td>
                  <td className="px-3 py-2 font-mono">{l.accounts}</td>
                  <td className="px-3 py-2 font-mono">{usdt(l.volume)}</td>
                  <td className="px-3 py-2 font-mono">{usdt(l.accrued)}</td>
                  <td className="px-3 py-2">
                    <Button
                      label={copied === l.code ? c.copied : c.copy} variant="ghost" size="sm"
                      onClick={() => void navigator.clipboard.writeText(url(l.code)).then(() => {
                        setCopied(l.code)
                        setTimeout(() => setCopied(null), 1500)
                      })}
                    />
                  </td>
                  {admin && (
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          inputMode="decimal" placeholder="USDT" value={bonuses[l.code] ?? ''}
                          onChange={e => setBonuses({ ...bonuses, [l.code]: e.target.value })}
                          className="w-24 rounded-input border border-border-subtle bg-bg-subtle px-2 py-1 font-mono text-text-primary"
                        />
                        <Button
                          label={c.save} size="sm" disabled={busy || wei === undefined}
                          onClick={() => wei !== undefined && void run({ action: 'setBonus', code: l.code, bonus: wei })}
                        />
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function AutopayPanel({ report, autopay, busy, run }: { report: Report; autopay: Autopay; busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const due = report.partners.map(p => BigInt(p.owed)).filter(o => o >= AUTOPAY_LIMITS.min).reduce((s, o) => s + o, 0n)
  const held = autopay.lastStatus === 'held'
  return (
    <Panel title={c.autopay}>
      <div className="flex flex-col gap-3 text-note">
        <p className="text-text-tertiary">{OURO_REF_PAYER ? c.autopayNote(OURO_REF_PAYER) : c.noPayer}</p>
        <p className="text-text-secondary">
          {autopay.enabled ? c.autopayOn : c.autopayOff}
          {autopay.lastRunAt && ` · ${c.lastRun} ${new Date(autopay.lastRunAt).toLocaleString()}: ${c.status[autopay.lastStatus as keyof typeof c.status] ?? autopay.lastStatus}`}
        </p>
        {autopay.lastDetail && <p className="font-mono text-text-tertiary">{autopay.lastDetail}</p>}
        {held && due > 0n && (
          <Button
            label={`${c.approve} · ${usdt(due.toString())}`}
            onClick={() => void run({ action: 'approvePayout', maxTotal: due.toString() })}
            disabled={busy}
          />
        )}
      </div>
    </Panel>
  )
}

function Balances({ report }: { report: Report }) {
  const c = usePartnersCopy()
  if (report.partners.length === 0) return null
  return (
    <Panel title={c.partners}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-note">
          <thead className="text-label uppercase text-text-tertiary">
            <tr>
              <th className="px-3 py-2">{c.partner}</th>
              <th className="px-3 py-2">{c.accrued}</th>
              <th className="px-3 py-2">{c.paid}</th>
              <th className="px-3 py-2">{c.owed}</th>
            </tr>
          </thead>
          <tbody>
            {report.partners.map(p => (
              <tr key={p.partner} className="border-t border-border-subtle">
                <td className="px-3 py-2 font-mono"><AddressLink value={p.partner} display="full" /></td>
                <td className="px-3 py-2 font-mono">{usdt(p.accrued)}</td>
                <td className="px-3 py-2 font-mono">{usdt(p.paid)}</td>
                <td className="px-3 py-2 font-mono text-text-primary">{usdt(p.owed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Payouts({ report }: { report: Report }) {
  const c = usePartnersCopy()
  return (
    <Panel title={c.payouts}>
      {report.payouts.length === 0 ? (
        <p className="text-note text-text-tertiary">{c.noPayouts}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-note">
          {report.payouts.map(p => (
            <li key={`${p.txHash}-${p.logIndex}`} className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono"><AddressLink value={p.partner} /></span>
              <span className="font-mono">{usdt(p.amount)}</span>
              <span className="font-mono text-text-tertiary"><AddressLink value={p.txHash} kind="tx" /></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function AdminForms({ busy, run }: { busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [code, setCode] = useState('')
  const [partner, setPartner] = useState('')
  const [label, setLabel] = useState('')
  const [bonus, setBonus] = useState('5')
  const [txHash, setTxHash] = useState('')
  const wei = toWei(bonus)

  const create = async () => {
    if (wei === undefined) return
    const ok = await run({ action: 'createLink', code: code.trim().toLowerCase(), partner: partner.trim(), label: label.trim(), bonus: wei })
    if (ok) { setCode(''); setPartner(''); setLabel(''); setBonus('5') }
  }
  const record = async () => {
    if (await run({ action: 'recordPayout', txHash: txHash.trim() })) setTxHash('')
  }

  return (
    <>
      <Panel title={c.newLink}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={c.code} value={code} onChange={setCode} />
            <Button label={c.randomCode} onClick={() => setCode(randomRefCode())} disabled={busy} />
            <Field label={c.partner} value={partner} onChange={setPartner} />
            <Field label={c.label} value={label} onChange={setLabel} />
            <Field label={`${c.bonus} (USDT)`} value={bonus} onChange={setBonus} />
            <Button label={c.create} onClick={() => void create()} disabled={busy || wei === undefined || !code || !partner} />
          </div>
          <p className="text-note text-text-tertiary">{c.bonusNote}</p>
        </div>
      </Panel>
      <Panel title={c.recordPayout}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={c.txHash} value={txHash} onChange={setTxHash} />
            <Button label={c.record} onClick={() => void record()} disabled={busy || !txHash} />
          </div>
          <p className="text-note text-text-tertiary">{c.recordNote}</p>
        </div>
      </Panel>
    </>
  )
}
