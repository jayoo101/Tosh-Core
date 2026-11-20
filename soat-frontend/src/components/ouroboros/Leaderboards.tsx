'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Panel } from '@/components/x/Panel'
import { cn } from '@/components/ui'

import { useOuroCopy } from './copy'
import { fmt, shortAddr } from './fmt'

type Board = 'l1' | 'l2'

/** Rows shown per board. */
const BOARD_SHOWN = 20

interface LbRow {
  account: string
  shares?: number
  volume: string
}

export function Leaderboards({ address, embedded = false }: { address: string | undefined; embedded?: boolean }) {
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
  // L1.5 换手榜 intentionally hidden from the UI.
  const tabs: [Board, string][] = [['l1', c.boardL1], ['l2', c.boardL2]]
  const me = address?.toLowerCase()

  const body = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setBoard(id)}
              className={cn(
                'rounded-pill border px-3.5 py-1.5 font-mono text-note font-bold transition-colors',
                board === id ? 'border-brand bg-brand/15 text-brand' : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-note text-text-tertiary">{c.boardNote}</p>
      </div>
      {isError ? (
        <p className="text-note text-text-tertiary">{c.boardDown}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-subtle">
          <table className="w-full border-collapse text-note">
            <thead>
              <tr className="bg-bg-subtle text-left text-text-tertiary">
                <th className="w-14 px-3 py-2.5">{c.rank}</th>
                <th className="px-3 py-2.5">{c.account}</th>
                <th className="px-3 py-2.5 text-right">{c.shares}</th>
                <th className="px-3 py-2.5 text-right">{c.volume}</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && (data ?? []).length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-text-tertiary">{c.nothing}</td></tr>
              )}
              {(data ?? []).slice(0, BOARD_SHOWN).map((r, idx) => (
                <tr key={r.account} className={cn('border-t border-border-subtle', r.account === me && 'bg-brand/10')}>
                  <td className="px-3 py-2.5 font-mono">
                    <span className={cn(
                      'inline-flex min-w-7 items-center justify-center rounded-pill px-1.5 py-0.5 text-micro font-bold',
                      idx === 0 ? 'border border-brand/50 bg-brand/15 text-brand'
                        : idx === 1 ? 'border border-border-strong bg-surface-elevated text-text-primary'
                          : idx === 2 ? 'border border-warning/45 bg-warning/10 text-warning'
                            : 'text-text-tertiary',
                    )}>
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-text-primary">{shortAddr(r.account)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{r.shares}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-bold text-text-primary">{fmt(BigInt(r.volume.split('.')[0]), 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  if (embedded) return body
  return <Panel title={c.boards}>{body}</Panel>
}
