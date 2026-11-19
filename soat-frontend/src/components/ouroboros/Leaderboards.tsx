'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Panel } from '@/components/x/Panel'
import { cn } from '@/components/ui'

import { useOuroCopy } from './copy'
import { fmt, shortAddr } from './fmt'

type Board = 'l1' | 'l15' | 'l2'

interface LbRow {
  account: string
  shares?: number
  fills?: number
  volume: string
}

export function Leaderboards({ address }: { address: string | undefined }) {
  const c = useOuroCopy()
  const [board, setBoard] = useState<Board>('l1')
  const { data, isError, isLoading } = useQuery({
    queryKey: ['ouro-lb', board],
    queryFn: async () => {
      const r = await fetch(`/api/ouroboros/leaderboard?board=${board}`)
      if (!r.ok) throw new Error(String(r.status))
      return ((await r.json()) as { rows: LbRow[] }).rows
    },
    refetchInterval: 30_000,
  })
  const tabs: [Board, string][] = [['l1', c.boardL1], ['l15', c.boardL15], ['l2', c.boardL2]]
  const me = address?.toLowerCase()

  return (
    <Panel title={c.boards}>
      <div className="flex gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setBoard(id)}
            className={cn(
              'rounded-pill border px-3 py-1 font-mono text-note',
              board === id ? 'border-brand bg-brand/10 text-brand' : 'border-border-subtle text-text-secondary',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {isError ? (
        <p className="text-note text-text-tertiary">{c.boardDown}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-subtle">
          <table className="w-full border-collapse text-note">
            <thead>
              <tr className="bg-bg-subtle text-left text-text-tertiary">
                <th className="px-3 py-2">{c.rank}</th>
                <th className="px-3 py-2">{c.account}</th>
                <th className="px-3 py-2 text-right">{board === 'l15' ? c.fills : c.shares}</th>
                <th className="px-3 py-2 text-right">{c.volume}</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && (data ?? []).length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-center text-text-tertiary">{c.nothing}</td></tr>
              )}
              {(data ?? []).map((r, i) => (
                <tr key={r.account} className={cn('border-t border-border-subtle', r.account === me && 'bg-brand/5')}>
                  <td className="px-3 py-2 font-mono">{i + 1}</td>
                  <td className="px-3 py-2 font-mono">{shortAddr(r.account)}</td>
                  <td className="px-3 py-2 text-right font-mono">{board === 'l15' ? r.fills : r.shares}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(BigInt(r.volume.split('.')[0]), 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-note text-text-tertiary">{c.boardNote}</p>
    </Panel>
  )
}
