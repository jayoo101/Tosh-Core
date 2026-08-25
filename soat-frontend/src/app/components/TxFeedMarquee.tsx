'use client'

/**
 * TxFeedMarquee — A2A-style on-chain heartbeat ticker.
 *
 * Subscribes to three factory-level events that together cover most of the
 * activity a visitor cares about:
 *
 *   • LaunchCreated  — new hook deployed, fair-launch ignition
 *   • PoGRegistered  — wallet bound a fresh PoG quota
 *   • GenesisDeposit — ETH flowed into an open Phase 1 hook
 *
 * Each event maps to a fixed-format pill (`[ TYPE ] // payload`).  The newest
 * 24 events are kept in a ring buffer, then rendered twice back-to-back so
 * the CSS `tosh-marquee-track` animation can do a seamless `translateX(-50%)`
 * loop without snapping at the wrap point.
 *
 * Cyber-minimal styling: pure black background, hairline #1F1F2E rule top &
 * bottom, JetBrains Mono only, phase-tinted dot prefix per event type.  The
 * hover handler pauses the animation so a visitor can read a long string.
 *
 * Hydration safety: on SSR the buffer is empty so we render a static seed
 * pill (`AWAITING_TX…`).  Once the first log arrives the seed is replaced.
 * No timestamp is rendered server-side, so SSR/CSR mismatches are impossible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWatchContractEvent } from 'wagmi'
import { formatUnits, type Address, type Log } from 'viem'

import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TxKind = 'LAUNCH' | 'POG' | 'DEPOSIT'

interface FeedItem {
  /** Stable key — `${txHash}:${logIndex}`.  Used to deduplicate WebSocket
   *  redelivery and React reconciliation. */
  key:    string
  kind:   TxKind
  /** Already-formatted payload (`tosh_v2 · 0xab…cd`). */
  payload: string
}

const RING_LIMIT = 24

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function shortAddr(addr: string | undefined | null): string {
  if (!addr) return '0x…'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function shortEth(wei: bigint | undefined): string {
  if (wei === undefined) return '—'
  const n = Number(formatUnits(wei, 18))
  if (n === 0) return '0'
  if (n < 0.01) return '<0.01'
  if (n < 1000) return n.toFixed(2)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TxFeedMarquee({ compact = false }: { compact?: boolean }) {
  // Ring buffer — newest first.  Stored in state so React can re-render the
  // marquee when a new log arrives without us forcing the issue.
  const [buffer, setBuffer] = useState<FeedItem[]>([])
  // Seen-keys set — survives across event handlers so we don't double-insert
  // when a node re-broadcasts the same log on a re-org / reconnect.
  const seen = useRef<Set<string>>(new Set())

  /** Generic insert — kind-agnostic; the caller has already formatted the
   *  payload.  Dedupes via `seen`, then prepends to the ring and trims. */
  const ingest = useCallback((items: FeedItem[]) => {
    if (items.length === 0) return
    setBuffer(prev => {
      const fresh: FeedItem[] = []
      for (const it of items) {
        if (seen.current.has(it.key)) continue
        seen.current.add(it.key)
        fresh.push(it)
      }
      if (fresh.length === 0) return prev
      return [...fresh, ...prev].slice(0, RING_LIMIT)
    })
  }, [])

  // ── LaunchCreated ──────────────────────────────────────────────────────
  useWatchContractEvent({
    address:   FACTORY_ADDRESS,
    abi:       FACTORY_ABI,
    eventName: 'LaunchCreated',
    onLogs(logs) {
      ingest(logs.map((l) => {
        const log = l as unknown as Log & {
          args: { launchId?: bigint, token?: Address, symbol?: string, name?: string }
        }
        const args   = log.args ?? {}
        const symbol = (args.symbol ?? '?').slice(0, 8) || '?'
        return {
          key:    `${log.transactionHash ?? '0x'}:${log.logIndex ?? 0}`,
          kind:   'LAUNCH' as const,
          payload: `$${symbol} · token ${shortAddr(args.token)}`,
        }
      }))
    },
  })

  // ── PoGRegistered ──────────────────────────────────────────────────────
  useWatchContractEvent({
    address:   FACTORY_ADDRESS,
    abi:       FACTORY_ABI,
    eventName: 'PoGRegistered',
    onLogs(logs) {
      ingest(logs.map((l) => {
        const log = l as unknown as Log & {
          args: { user?: Address, quota?: bigint }
        }
        const args = log.args ?? {}
        return {
          key:    `${log.transactionHash ?? '0x'}:${log.logIndex ?? 0}`,
          kind:   'POG' as const,
          payload: `${shortAddr(args.user)} · quota ${shortEth(args.quota)} ETH`,
        }
      }))
    },
  })

  // ── GenesisDeposit ─────────────────────────────────────────────────────
  useWatchContractEvent({
    address:   FACTORY_ADDRESS,
    abi:       FACTORY_ABI,
    eventName: 'GenesisDeposit',
    onLogs(logs) {
      ingest(logs.map((l) => {
        const log = l as unknown as Log & {
          args: { user?: Address, hook?: Address, amount?: bigint }
        }
        const args = log.args ?? {}
        return {
          key:    `${log.transactionHash ?? '0x'}:${log.logIndex ?? 0}`,
          kind:   'DEPOSIT' as const,
          payload: `${shortAddr(args.user)} → ${shortAddr(args.hook)} · ${shortEth(args.amount)} ETH`,
        }
      }))
    },
  })

  // Mount guard — buffer starts empty on SSR; surface a single seed pill
  // until the first log lands so the marquee always has visible content.
  // The setMounted call is the canonical "mark as hydrated" pattern — it
  // runs exactly once, never depends on incoming props, and never cascades.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  const items = useMemo<FeedItem[]>(() => {
    if (buffer.length > 0) return buffer
    return [{
      key:     'seed',
      kind:    'LAUNCH',
      payload: 'AWAITING_TX · subscribed to factory events',
    }]
  }, [buffer])

  // Doubled track — render twice back-to-back so translateX(-50%) wraps
  // seamlessly.  `aria-hidden` on the duplicate keeps it out of the a11y
  // tree.  We hide everything until `mounted` so the SSR HTML stays empty
  // and there's no static / animated marquee mismatch on hydration.
  //
  // CONTAINMENT (v4.4 · 2026-05-24)
  // ────────────────────────────────────────────────────────────────────
  // The ticker is wrapped in the same `<section px-6><div max-w-7xl mx-auto>`
  // shell that Hero / ProtocolPulse / LaunchRadar use, with the bordered
  // box drawn on an INNER `<div>` so all four borders sit at the shared
  // max-w-7xl content column edges.  The mount-guard placeholder uses the
  // identical wrapping so the SSR → CSR transition does not produce a
  // horizontal layout shift on hydration.
  // Keep a single DOM structure for both SSR and CSR to avoid React
  // removeChild/insertBefore hydration errors. On SSR (mounted=false) we
  // render the outer shell with invisible content so the layout height is
  // reserved; the marquee content fades in after mount via opacity.
  return (
    <section className={compact ? 'relative font-mono' : 'relative px-6 font-mono'}>
      <div className={compact ? '' : 'mx-auto max-w-7xl'}>
        <div className={`${compact ? 'border-zinc-800 bg-zinc-950/50 rounded-lg' : 'border-[#1F1F2E] bg-black'} border overflow-hidden`}
             style={{ minHeight: '2rem' }}>
          {mounted && (
            <div className="tosh-marquee-track py-1.5 whitespace-nowrap">
              <FeedRow items={items} />
              <FeedRow items={items} ariaHidden />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FeedRow — half of the doubled marquee track
// ─────────────────────────────────────────────────────────────────────────────

function FeedRow({ items, ariaHidden }: { items: FeedItem[], ariaHidden?: boolean }) {
  return (
    <div aria-hidden={ariaHidden} className="inline-flex items-center gap-6 px-6">
      {items.map((it, i) => (
        <FeedPill key={`${it.key}-${ariaHidden ? 'b' : 'a'}-${i}`} item={it} />
      ))}
    </div>
  )
}

const KIND_DOT: Record<TxKind, string> = {
  LAUNCH:  'bg-warning',  // one-shot ignition = notice tint
  POG:     'bg-brand',   // attestation       = primary fluo
  DEPOSIT: 'bg-info',  // curve commitment  = phase-2 cyan
}
const KIND_TEXT: Record<TxKind, string> = {
  LAUNCH:  'text-warning',
  POG:     'text-brand',
  DEPOSIT: 'text-info',
}

function FeedPill({ item }: { item: FeedItem }) {
  return (
    <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.32em] uppercase">
      <span aria-hidden className={`inline-block h-1.5 w-1.5 ${KIND_DOT[item.kind]}`} />
      <span className={KIND_TEXT[item.kind]}>[ {item.kind} ]</span>
      <span className="text-[#888] normal-case tracking-normal">{item.payload}</span>
      <span aria-hidden className="text-[#222] pl-2">·</span>
    </span>
  )
}
