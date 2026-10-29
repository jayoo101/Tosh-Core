'use client'

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'

import { AddressLink, Card } from '@/components/ui'
import { fill, useT } from '@/i18n'
import type { V2Quote } from '@/lib/v2/config'
import { fmtSig } from './fmt'

interface TradeRow { tx_hash: string; log_index: number; seller: string; qty: string; price: string; gross: string; block_number: number }

/** All-time fill count and gross for one launch; `undefined` while the index is unavailable. */
export function useBidVolume(hook: Address) {
  return useQuery({
    queryKey: ['v2-volume', hook],
    refetchInterval: 15_000,
    queryFn: async (): Promise<{ count: number; gross: bigint } | null> => {
      const r = await fetch(`/api/v2/volume?hook=${hook}`, { cache: 'no-store' })
      if (!r.ok) return null
      const v = (await r.json()) as { count: number; gross: string }
      return { count: v.count, gross: BigInt(v.gross) }
    },
  }).data ?? undefined
}

/** Fills from the index. Hidden while the index is unavailable: this list is history, not state. */
export function RecentTrades({ hook, quote }: { hook: Address; quote: V2Quote }) {
  const t = useT().v2
  const { data } = useQuery({
    queryKey: ['v2-trades', hook],
    refetchInterval: 15_000,
    queryFn: async (): Promise<TradeRow[] | null> => {
      const r = await fetch(`/api/v2/trades?hook=${hook}`, { cache: 'no-store' })
      if (!r.ok) return null
      return ((await r.json()) as { trades: TradeRow[] }).trades
    },
  })
  if (!data || data.length === 0) return null
  return (
    <Card title={t.tradesTitle}>
      <table className="w-full font-mono text-note tabular-nums">
        <thead className="text-label text-text-tertiary">
          <tr>
            <th className="py-1 text-left">{fill(t.colPrice, { quote: quote.symbol })}</th>
            <th className="py-1 text-right">{t.colQty}</th>
            <th className="py-1 text-right">{fill(t.colTotal, { quote: quote.symbol })}</th>
            <th className="py-1 text-right">{t.colSeller}</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map(r => (
            <tr key={`${r.tx_hash}-${r.log_index}`}>
              <td className="py-1">{fmtSig(BigInt(r.price), 18, 6)}</td>
              <td className="py-1 text-right">{fmtSig(BigInt(r.qty))}</td>
              <td className="py-1 text-right">{fmtSig(BigInt(r.gross))}</td>
              <td className="py-1 text-right"><AddressLink value={r.seller} copyable={false} className="text-note" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
