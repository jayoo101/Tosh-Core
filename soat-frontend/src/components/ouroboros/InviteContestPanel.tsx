'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

import { Button } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { CONTEST_RULES_EN, CONTEST_RULES_ZH } from '@/lib/ouroboros/contest'
import { isRefCode, randomRefCode, refMessage } from '@/lib/ouroboros/ref'
import { useLocale } from '@/i18n'

import { useOuroCopy } from './copy'

type LinkStatus = 'none' | 'pending' | 'live' | 'rejected'

function MiniField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
      <span className="text-label uppercase text-text-tertiary">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-input border border-border-subtle bg-bg-base px-3 py-2 font-mono text-note text-text-primary"
      />
    </label>
  )
}

/**
 * Invite-contest apply strip under the L1.5 book stats: code + label, a
 * copyable invite URL as soon as the code is valid, and a live/pending badge.
 */
export function InviteContestPanel() {
  const c = useOuroCopy()
  const rules = useLocale().startsWith('zh') ? CONTEST_RULES_ZH : CONTEST_RULES_EN
  const picker = useWalletPicker()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [record, setRecord] = useState<{ code: string; status: LinkStatus; reason: string | null } | null>(null)

  const normalized = code.trim().toLowerCase()
  const valid = isRefCode(normalized)
  const inviteUrl = useMemo(() => {
    if (!valid || typeof window === 'undefined') return null
    return `${window.location.origin}/ouroboros?ref=${normalized}`
  }, [valid, normalized])
  const shown = valid && record?.code === normalized ? record : null
  const status: LinkStatus = shown?.status ?? 'none'
  const rejectReason = shown?.reason ?? null
  const remember = (next: LinkStatus, reason: string | null = null) => {
    setRecord({ code: normalized, status: next, reason })
  }

  useEffect(() => {
    if (!valid) return
    let cancelled = false
    const tick = async () => {
      try {
        const r = await fetch(`/api/ouroboros/ref/check?code=${normalized}`)
        if (!r.ok || cancelled) return
        const body = await r.json() as { registered?: boolean }
        if (body.registered) setRecord({ code: normalized, status: 'live', reason: null })
      } catch { /* ignore */ }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 30_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [valid, normalized])

  const refreshMine = async () => {
    if (!address || !valid) return
    setBusy(true)
    setMessage(null)
    try {
      const issuedAt = Date.now()
      const request = { action: 'view' as const }
      const signature = await signMessageAsync({ message: refMessage(request, issuedAt) })
      const res = await fetch('/api/ouroboros/ref', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, issuedAt, address, signature }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? res.statusText)
      const apps = (body.report?.applications ?? []) as {
        code: string; status: string; rejectReason: string | null
      }[]
      const mine = apps.find(a => a.code === normalized)
      if (!mine) {
        setMessage(null)
        return
      }
      if (mine.status === 'approved') remember('live')
      else if (mine.status === 'pending') remember('pending')
      else if (mine.status === 'rejected') remember('rejected', mine.rejectReason)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!address || !valid) return
    setBusy(true)
    setMessage(null)
    try {
      const issuedAt = Date.now()
      const request = { action: 'apply' as const, code: normalized, label: label.trim() }
      const signature = await signMessageAsync({ message: refMessage(request, issuedAt) })
      const res = await fetch('/api/ouroboros/ref', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, issuedAt, address, signature }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? res.statusText)
      remember('pending')
      setMessage(c.inviteApplied)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const badge =
    status === 'live' ? c.inviteLive
      : status === 'pending' ? c.invitePending
        : status === 'rejected' ? `${c.inviteRejected}${rejectReason ? ` · ${rejectReason}` : ''}`
          : null

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-subtle bg-bg-subtle/60 p-4 md:p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-label uppercase text-text-tertiary">{c.inviteTitle}</h3>
        <p className="text-note text-text-secondary">{c.inviteNote}</p>
        <p className="whitespace-pre-line text-note text-text-tertiary">{rules}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <MiniField label={c.refCode} value={code} onChange={setCode} />
        <Button label={c.inviteRandom} onClick={() => setCode(randomRefCode())} disabled={busy} />
        <MiniField label={c.inviteLabel} value={label} onChange={setLabel} />
        {!address ? (
          <Button label={c.inviteConnect} onClick={() => picker?.open()} />
        ) : (
          <>
            <Button
              label={busy ? c.inviteApplying : c.inviteApply}
              onClick={() => void apply()}
              disabled={busy || !valid}
            />
            {valid && (
              <Button
                label={c.inviteCheck}
                variant="ghost"
                onClick={() => void refreshMine()}
                disabled={busy}
              />
            )}
          </>
        )}
      </div>

      {inviteUrl && (
        <div className="flex flex-col gap-2 rounded-input border border-border-subtle bg-bg-base px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-label uppercase text-text-tertiary">{c.inviteUrl}</span>
            {badge && (
              <span className={`text-note ${status === 'live' ? 'text-brand' : 'text-text-secondary'}`}>
                {badge}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-note text-text-primary">{inviteUrl}</code>
            <Button label={copied ? c.inviteCopied : c.inviteCopy} size="sm" onClick={() => void copy()} />
          </div>
        </div>
      )}

      {message && <p className="text-note text-text-secondary">{message}</p>}
    </div>
  )
}
