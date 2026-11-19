'use client'

import { Panel } from '@/components/x/Panel'
import { Badge, cn } from '@/components/ui'
import { TIERS, ladderPrice, tierEnd } from '@/lib/ouroboros/ladder'

import { useOuroCopy } from './copy'
import { fmtPrice } from './fmt'

const num = (n: number) => n.toLocaleString('en-US')

export function LadderTable({ minted }: { minted: number }) {
  const c = useOuroCopy()
  const next = minted + 1

  return (
    <Panel title={c.ladder}>
      <div className="overflow-x-auto rounded-card border border-border-subtle">
        <table className="w-full border-collapse text-note">
          <thead>
            <tr className="bg-bg-subtle text-left text-text-tertiary">
              <th className="px-3 py-2">{c.range}</th>
              <th className="px-3 py-2">{c.ladderPrice}</th>
              <th className="px-3 py-2">{c.ladderStep}</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map(t => {
              const here = next >= t.from && next <= t.to
              return (
                <tr key={t.from} className={cn('border-t border-border-subtle', here && 'bg-brand/5')}>
                  <td className="px-3 py-2 font-mono">
                    {num(t.from)} – {num(t.to)}
                    {here && <Badge tone="info" size="sm">{`${c.current} ${fmtPrice(ladderPrice(next))}`}</Badge>}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {t.step === 0n ? fmtPrice(t.start) : `${fmtPrice(t.start)} → ${fmtPrice(tierEnd(t))}`}
                  </td>
                  <td className="px-3 py-2 text-text-tertiary">
                    {t.step === 0n ? c.flat : c.stepEvery(num(t.every), fmtPrice(t.step))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
