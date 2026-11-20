'use client'

import { useQuery } from '@tanstack/react-query'

import { Panel } from '@/components/x/Panel'
import { cn } from '@/components/ui'

import { useOuroCopy } from './copy'
import { fmt } from './fmt'

interface InviteRow {
  code: string
  filled: number
  rewarded: string
}

/** Invite links ranked by the Agent IDs they filled (see `board=ref`). */
export function Leaderboards({ embedded = false }: { address?: string | undefined; embedded?: boolean }) {
  const c = useOuroCopy()
  const { data, isError, isLoading } = useQuery({
    queryKey: ['ouro-lb', 'ref'],
    queryFn: async () => {
      const r = await fetch('/api/ouroboros/leaderboard?board=ref')
      if (!r.ok) throw new Error(String(r.status))
      return ((await r.json()) as { rows: InviteRow[] }).rows
    },
    refetchInterval: 30_000,
  })

  const body = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-note text-text-secondary">{c.inviteBoardNote}</p>
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
                <th className="px-3 py-2.5">{c.inviteCode}</th>
                <th className="px-3 py-2.5 text-right">{c.inviteFilled}</th>
                <th className="px-3 py-2.5 text-right">{c.inviteRewarded}</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && (data ?? []).length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-text-tertiary">{c.nothing}</td></tr>
              )}
              {(data ?? []).map((r, idx) => (
                <tr key={r.code} className="border-t border-border-subtle">
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
                  <td className="px-3 py-2.5 font-mono text-text-primary">{r.code}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{r.filled}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-bold text-text-primary">{fmt(BigInt(r.rewarded.split('.')[0]), 2)}</td>
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
