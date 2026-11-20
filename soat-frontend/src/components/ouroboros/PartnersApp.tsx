'use client'

import { useEffect, useState } from 'react'
import { parseAbi, parseUnits } from 'viem'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'

import { Panel } from '@/components/x/Panel'
import { AddressLink, Button } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { AUTOPAY_LIMITS } from '@/lib/ouroboros/autopayPlan'
import { OURO_REF_PAYER, OURO_TREASURY } from '@/lib/ouroboros/config'
import { CONTEST_RULES_EN, CONTEST_RULES_ZH } from '@/lib/ouroboros/contest'
import { MAX_REF_BONUS_WEI, randomRefCode, refMessage, type RefAction } from '@/lib/ouroboros/ref'
import { useLocale } from '@/i18n'

import { Field } from './BidBookPanel'
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
  holds?: { agentKey: string; rank: number; reason: string | null; partner: string; account: string }[]
}

interface Autopay { enabled: boolean; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null }

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
  const rules = useLocale().startsWith('zh') ? CONTEST_RULES_ZH : CONTEST_RULES_EN
  const picker = useWalletPicker()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const signer = useReadContract({
    address: OURO_TREASURY, abi: SAFE_ABI, functionName: 'isOwner', args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID, query: { enabled: ADMIN_ENABLED && OURO_TREASURY !== undefined && address !== undefined },
  })
  const isAdmin = ADMIN_ENABLED && signer.data === true

  // Kept with the wallet that signed for it, and shown only while that wallet
  // is connected: switching wallets must not leave an admin listing on screen.
  const [fetched, setFetched] = useState<{ by: string; report: Report; autopay: Autopay | null } | null>(null)
  const report = fetched && fetched.by === address ? fetched.report : null
  const autopay = fetched && fetched.by === address ? fetched.autopay : null
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const run = async (request: RefAction) => {
    if (!address) return
    setBusy(true)
    setMessage(null)
    try {
      const issuedAt = Date.now()
      const signature = await signMessageAsync({ message: refMessage(request, issuedAt) })
      const res = await fetch('/api/ouroboros/ref', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, issuedAt, address, signature }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? res.statusText)
      setFetched({ by: address, report: body.report, autopay: body.autopay ?? null })
      if (typeof body.recorded === 'number') setMessage(c.recorded(body.recorded))
      if (request.action === 'apply') setMessage(c.applyOk)
      return true
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel title={c.title}>
        <div className="flex flex-col gap-3">
          <p className="text-note text-text-secondary">{c.intro}</p>
          <p className="whitespace-pre-line text-note text-text-tertiary">{rules}</p>
          {address && (!ADMIN_ENABLED || signer.data !== undefined) && (
            <p className="text-note text-text-tertiary">{isAdmin ? c.adminRole : c.partnerRole}</p>
          )}
          {!address ? (
            <Button label={c.connect} onClick={() => picker?.open()} />
          ) : (
            <Button
              label={busy ? c.signing : c.sign}
              onClick={() => void run({ action: isAdmin ? 'list' : 'view' })}
              disabled={busy || (ADMIN_ENABLED && signer.isLoading)}
            />
          )}
          {message && <p className="text-note text-text-secondary">{message}</p>}
        </div>
      </Panel>

      {address && <ApplyForm busy={busy} run={run} />}

      {report && (
        <>
          <Applications report={report} admin={isAdmin} busy={busy} run={run} />
          {isAdmin && <Holds report={report} busy={busy} run={run} />}
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

function ApplyForm({ busy, run }: { busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState(false)
  const [liveCode, setLiveCode] = useState<string | null>(null)
  const normalized = code.trim().toLowerCase()
  const inviteUrl = typeof window !== 'undefined' && /^[a-z0-9]{3,16}$/.test(normalized)
    ? `${window.location.origin}/ouroboros?ref=${normalized}`
    : null
  const live = inviteUrl != null && liveCode === normalized

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

  return (
    <Panel title={c.applyTitle}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={c.code} value={code} onChange={setCode} />
          <Button label={c.randomCode} onClick={() => setCode(randomRefCode())} disabled={busy} />
          <Field label={c.label} value={label} onChange={setLabel} />
          <Button
            label={busy ? c.signing : c.applySubmit}
            onClick={() => void run({ action: 'apply', code: normalized, label: label.trim() })}
            disabled={busy || !inviteUrl}
          />
        </div>
        {inviteUrl && (
          <div className="flex flex-col gap-2 rounded-input border border-border-subtle bg-bg-subtle px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-label uppercase text-text-tertiary">{c.url}</span>
              <span className={`text-note ${live ? 'text-brand' : 'text-text-secondary'}`}>
                {live ? c.linkLive : c.linkPending}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-note">{inviteUrl}</code>
              <Button
                label={copied ? c.copied : c.copy} size="sm"
                onClick={() => void navigator.clipboard.writeText(inviteUrl).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })}
              />
            </div>
          </div>
        )}
        <p className="text-note text-text-tertiary">{c.applyNote}</p>
      </div>
    </Panel>
  )
}

function Applications({ report, admin, busy, run }: { report: Report; admin: boolean; busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [reasons, setReasons] = useState<Record<number, string>>({})
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
          <thead className="text-text-tertiary">
            <tr>
              <th className="px-3 py-2">{c.code}</th>
              {admin && <th className="px-3 py-2">{c.partner}</th>}
              <th className="px-3 py-2">{c.label}</th>
              <th className="px-3 py-2">{c.appState}</th>
              {admin && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {apps.map(a => (
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
                      <Button
                        label={c.approveApp} size="sm" disabled={busy}
                        onClick={() => void run({ action: 'approveApplication', id: a.id })}
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
            ))}
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
          <thead className="text-text-tertiary">
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
          <thead className="text-text-tertiary">
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
      <ReviewForms busy={busy} run={run} />
    </>
  )
}

function Holds({ report, busy, run }: { report: Report; busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const holds = report.holds ?? []
  if (holds.length === 0) return <Panel title={c.holds}><p className="text-note text-text-tertiary">{c.noHolds}</p></Panel>
  return (
    <Panel title={c.holds}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-note">
          <thead className="text-text-tertiary">
            <tr>
              <th className="px-3 py-2">{c.agentKey}</th>
              <th className="px-3 py-2">{c.reviewReason}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {holds.map(h => (
              <tr key={h.agentKey} className="border-t border-border-subtle">
                <td className="px-3 py-2 font-mono">{h.agentKey}</td>
                <td className="px-3 py-2">{h.reason ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      placeholder={c.reviewReason} value={reasons[h.agentKey] ?? ''}
                      onChange={e => setReasons({ ...reasons, [h.agentKey]: e.target.value })}
                      className="w-48 rounded-input border border-border-subtle bg-bg-subtle px-2 py-1 text-text-primary"
                    />
                    <Button
                      label={c.disqualify} size="sm" disabled={busy || !(reasons[h.agentKey] ?? '').trim()}
                      onClick={() => void run({ action: 'reviewContest', agentKey: h.agentKey, decision: 'disqualify', reason: reasons[h.agentKey] ?? '' })}
                    />
                    <Button
                      label={c.clearReview} size="sm" variant="ghost" disabled={busy || !(reasons[h.agentKey] ?? '').trim()}
                      onClick={() => void run({ action: 'reviewContest', agentKey: h.agentKey, decision: 'clear', reason: reasons[h.agentKey] ?? '' })}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function ReviewForms({ busy, run }: { busy: boolean; run: Run }) {
  const c = usePartnersCopy()
  const [agentKey, setAgentKey] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [account, setAccount] = useState('')
  const [code, setCode] = useState('')
  const [partner, setPartner] = useState('')
  const [txHash, setTxHash] = useState('')
  const [linkReason, setLinkReason] = useState('')
  const assign = async () => {
    const ok = await run({
      action: 'reviewContest', decision: 'assign', agentKey: agentKey.trim(), reason: reasonText.trim(),
      account: account.trim(), code: code.trim().toLowerCase(), partner: partner.trim(),
    })
    if (ok) { setAgentKey(''); setReasonText(''); setAccount(''); setCode(''); setPartner('') }
  }
  const link = async () => {
    const ok = await run({
      action: 'linkContestSettlement', agentKey: agentKey.trim(), txHash: txHash.trim(), reason: linkReason.trim(),
    })
    if (ok) { setTxHash(''); setLinkReason('') }
  }
  return (
    <>
      <Panel title={c.assign}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={c.agentKey} value={agentKey} onChange={setAgentKey} />
            <Field label={c.mintAccount} value={account} onChange={setAccount} />
            <Field label={c.code} value={code} onChange={setCode} />
            <Field label={c.partner} value={partner} onChange={setPartner} />
            <Field label={c.reviewReason} value={reasonText} onChange={setReasonText} />
            <Button
              label={c.assign} disabled={busy || !agentKey || !account || !code || !partner || !reasonText.trim()}
              onClick={() => void assign()}
            />
          </div>
          <p className="text-note text-text-tertiary">{c.reviewReason}</p>
        </div>
      </Panel>
      <Panel title={c.linkSettlement}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={c.agentKey} value={agentKey} onChange={setAgentKey} />
            <Field label={c.txHash} value={txHash} onChange={setTxHash} />
            <Field label={c.reviewReason} value={linkReason} onChange={setLinkReason} />
            <Button label={c.link} disabled={busy || !agentKey || !txHash || !linkReason.trim()} onClick={() => void link()} />
          </div>
          <p className="text-note text-text-tertiary">{c.linkSettlementNote}</p>
        </div>
      </Panel>
    </>
  )
}
