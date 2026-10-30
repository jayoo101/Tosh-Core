'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isAddress, type Address } from 'viem'
import { usePublicClient } from 'wagmi'

import { Button, CardWell, Field } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { ACTIVE_CHAIN_LABEL, TARGET_CHAIN_ID } from '@/lib/chain'
import { encode, type AgentStep } from './agentEncode'

export type { AgentStep } from './agentEncode'

const ADDR_KEY = 'toshx:agent-address'
const ADDR_EVENT = 'toshx:agent-address-changed'

function subscribeAddr(cb: () => void) {
  window.addEventListener('storage', cb)
  window.addEventListener(ADDR_EVENT, cb)
  return () => { window.removeEventListener('storage', cb); window.removeEventListener(ADDR_EVENT, cb) }
}
function readAddr(): string {
  try { return window.localStorage.getItem(ADDR_KEY) ?? '' } catch { return '' }
}
function writeAddr(v: string) {
  try { window.localStorage.setItem(ADDR_KEY, v) } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(ADDR_EVENT))
}

/** The Agent wallet address last entered in any Agent sheet, for read-only views. */
export function useAgentAddress(): Address | undefined {
  const stored = useSyncExternalStore(subscribeAddr, readAddr, () => '')
  return isAddress(stored.trim()) ? (stored.trim() as Address) : undefined
}

/** The same stored Agent address, editable outside any sheet. */
export function AgentAddressField({ label }: { label: string }) {
  const stored = useSyncExternalStore(subscribeAddr, readAddr, () => '')
  return <Field label={label} value={stored} onValueChange={writeAddr} placeholder="0x…" />
}

/** Calls `onSeen` once the account's nonce moves past what it was when watching began. */
function useNonceWatch(account: Address | undefined, active: boolean, onSeen: () => void) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [seen, setSeen] = useState<Address | null>(null)
  const seenCb = useRef(onSeen)
  useEffect(() => { seenCb.current = onSeen }, [onSeen])

  useEffect(() => {
    if (!active || !account || !client) return
    let baseline: number | undefined
    let stopped = false
    const tick = async () => {
      try {
        const n = await client.getTransactionCount({ address: account, blockTag: 'latest' })
        if (stopped) return
        if (baseline === undefined) baseline = n
        else if (n > baseline) {
          baseline = n
          setSeen(account)
          seenCb.current()
        }
      } catch { /* transient RPC failure: the next tick retries */ }
    }
    void tick()
    const id = setInterval(() => void tick(), 5_000)
    return () => { stopped = true; clearInterval(id) }
  }, [account, active, client])

  return seen !== null && seen === account
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/**
 * "Run with Agent": the exact calls a Binance Agentic Wallet should make for
 * this action, numbered, with every prerequisite (wrap, approve) spelled out.
 * The page shows one copy button; the instruction text itself is folded away,
 * because the agent reads it, not the user. `steps` is null until the form
 * holds enough to build them; `template`, when given, is offered meanwhile: an
 * instruction that leaves the amount to the user. `defaultOpen` is followed
 * until the user toggles the sheet themselves.
 */
export function AgentModeSheet({ title, summary, steps, template, pending, notes = [], defaultOpen = false, onDone }: {
  title: string
  summary?: string
  steps: AgentStep[] | null
  template?: string
  /** What is still missing, in place of the generic "fill in the form". */
  pending?: string
  notes?: string[]
  defaultOpen?: boolean
  onDone?: () => void
}) {
  const t = useT().v2
  const [toggled, setOpen] = useState<boolean | null>(null)
  const open = toggled ?? defaultOpen
  const [copied, setCopied] = useState<'text' | 'data' | null>(null)
  const stored = useSyncExternalStore(subscribeAddr, readAddr, () => '')
  const account = isAddress(stored.trim()) ? (stored.trim() as Address) : undefined
  const seen = useNonceWatch(account, open, () => onDone?.())

  const encoded = useMemo(() => (steps ? steps.map(encode) : null), [steps])
  const instruction = useMemo(() => {
    if (!encoded) return ''
    const lines = [fill(t.agentInstrHead, { chain: ACTIVE_CHAIN_LABEL, id: String(TARGET_CHAIN_ID) })]
    encoded.forEach((e, i) => {
      lines.push(
        '',
        fill(t.agentInstrStep, { n: String(i + 1), note: e.note }),
        `  ${t.agentInstrContract}: ${e.to}`,
        `  ${t.agentInstrFn}: ${e.signature}`,
        `  ${t.agentInstrArgs}: ${e.args || '—'}`,
        `  ${t.agentInstrValue}: ${e.value.toString()}`,
        `  calldata: ${e.data}`,
      )
    })
    for (const n of notes) lines.push('', n)
    return lines.join('\n')
  }, [encoded, notes, t])

  const flash = (which: 'text' | 'data') => { setCopied(which); setTimeout(() => setCopied(null), 1500) }

  if (!open) {
    return <Button size="sm" variant="primary" label={t.agentOpen} onClick={() => setOpen(true)} />
  }

  return (
    <CardWell className="flex flex-col gap-3 text-note">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-label text-text-tertiary">{t.agentOpen}</p>
          <p className="text-text-primary">{title}</p>
          {summary && <p className="text-text-secondary">{summary}</p>}
        </div>
        <Button size="sm" variant="quiet" label={t.agentClose} onClick={() => setOpen(false)} />
      </div>
      {encoded ? (
        <>
          <Button full label={copied === 'text' ? t.agentCopied : t.agentCopy}
            onClick={() => void copy(instruction).then(ok => ok && flash('text'))} />
          <p className="text-text-tertiary">{t.agentHowTo}</p>
          <details className="text-text-tertiary">
            <summary className="cursor-pointer hover:text-text-primary">{t.agentShow}</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-input border border-border-subtle p-2 font-mono text-micro text-text-primary">
              {instruction}
            </pre>
            <Button className="mt-2" size="sm" variant="ghost" label={copied === 'data' ? t.agentCopied : t.agentCopyData}
              onClick={() => void copy(encoded.map(e => e.data).join('\n')).then(ok => ok && flash('data'))} />
          </details>
        </>
      ) : template ? (
        <>
          <Button full label={copied === 'text' ? t.agentCopied : t.agentCopyTemplate}
            onClick={() => void copy(template).then(ok => ok && flash('text'))} />
          <p className="text-text-tertiary">{t.agentTemplateHint}</p>
          <details className="text-text-tertiary">
            <summary className="cursor-pointer hover:text-text-primary">{t.agentShow}</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-input border border-border-subtle p-2 font-mono text-micro text-text-primary">
              {template}
            </pre>
          </details>
        </>
      ) : (
        <p className="text-text-tertiary">{pending ?? t.agentFillFirst}</p>
      )}
      <Field label={t.agentAddrLabel} value={stored} onValueChange={writeAddr} placeholder="0x…" />
      {account && <p className={seen ? 'text-success' : 'text-text-tertiary'}>{seen ? t.agentSeen : t.agentWatching}</p>}
    </CardWell>
  )
}
