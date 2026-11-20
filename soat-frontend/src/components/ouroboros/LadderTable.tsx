'use client'

import { useMemo, useState, type PointerEvent } from 'react'
import { formatUnits } from 'viem'

import { Panel } from '@/components/x/Panel'
import { Badge, cn } from '@/components/ui'
import { TIERS, ladderPrice, tierEnd } from '@/lib/ouroboros/ladder'

import { useOuroCopy } from './copy'
import { fmtPrice } from './fmt'

const num = (n: number) => n.toLocaleString('en-US')
const L1_PRICE_NUM = 0.9
const MAX_PRICE_NUM = 16.6

const W = 800
const H = 264
const PAD = { l: 44, r: 54, t: 24, b: 34 }
const PLOT_W = W - PAD.l - PAD.r
const PLOT_H = H - PAD.t - PAD.b

const MILESTONES = [
  { shares: 1, label: '0' },
  { shares: 10_000, label: '10K' },
  { shares: 20_000, label: '20K' },
  { shares: 100_000, label: '100K' },
  { shares: 1_000_000, label: '1M' },
  { shares: 5_000_000, label: '5M' },
  { shares: 21_000_000, label: '21M' },
] as const

const SEG_COUNT = MILESTONES.length - 1
const CHART_FONT = 'var(--font-sans)'

function xFracToShares(frac: number): number {
  const f = Math.max(0, Math.min(1, frac))
  const scaled = f * SEG_COUNT
  const idx = Math.min(SEG_COUNT - 1, Math.floor(scaled))
  const local = scaled - idx
  const a = MILESTONES[idx].shares
  const b = MILESTONES[idx + 1].shares
  return Math.max(1, Math.round(a + (b - a) * local))
}

function sharesToXFrac(shares: number): number {
  const s = Math.max(1, Math.min(21_000_000, shares))
  for (let i = 0; i < SEG_COUNT; i++) {
    const a = MILESTONES[i].shares
    const b = MILESTONES[i + 1].shares
    if (s <= b) {
      const local = b === a ? 0 : (s - a) / (b - a)
      return (i + local) / SEG_COUNT
    }
  }
  return 1
}

function priceToY(p: number): number {
  return PAD.t + PLOT_H * (1 - Math.min(p, MAX_PRICE_NUM) / MAX_PRICE_NUM)
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
  }
  return d
}

function fmtSharesShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return num(n)
}

export function LadderTable({ minted, embedded = false }: { minted: number; embedded?: boolean }) {
  const c = useOuroCopy()
  const [hoverFrac, setHoverFrac] = useState<number | null>(null)
  const [selectedTier, setSelectedTier] = useState<number | null>(null)

  const next = Math.min(21_000_000, minted + 1)
  const globalPct = Math.min(100, (minted / 21_000_000) * 100)
  const segW = PLOT_W / SEG_COUNT

  const chart = useMemo(() => {
    const samples = 120
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= samples; i++) {
      const f = i / samples
      const sh = xFracToShares(f)
      const p = Number(formatUnits(ladderPrice(sh), 18))
      pts.push({ x: PAD.l + f * PLOT_W, y: priceToY(p) })
    }
    const lineD = smoothPath(pts)
    const baseY = PAD.t + PLOT_H
    const areaD = `${lineD} L${(PAD.l + PLOT_W).toFixed(2)},${baseY.toFixed(2)} L${PAD.l.toFixed(2)},${baseY.toFixed(2)} Z`
    const knots = MILESTONES.map((m, idx) => {
      const f = idx / SEG_COUNT
      const p = Number(formatUnits(ladderPrice(m.shares), 18))
      return { ...m, idx, x: PAD.l + f * PLOT_W, y: priceToY(p), price: p }
    })
    return { lineD, areaD, knots, baseY }
  }, [])

  const activeFrac = hoverFrac !== null
    ? hoverFrac
    : selectedTier !== null
      ? (selectedTier + 0.5) / SEG_COUNT
      : sharesToXFrac(next)

  const activeShares = xFracToShares(activeFrac)
  const activePrice = Number(formatUnits(ladderPrice(activeShares), 18))
  const activeMult = activePrice / L1_PRICE_NUM
  const activeTierIdx = Math.max(0, TIERS.findIndex(t => activeShares >= t.from && activeShares <= t.to))
  const cursorX = PAD.l + activeFrac * PLOT_W
  const cursorY = priceToY(activePrice)
  const l1Y = priceToY(L1_PRICE_NUM)
  const peakY = priceToY(15.18)

  const bandX = PAD.l + activeTierIdx * segW
  const tooltipW = 138
  const tooltipH = 42
  const tooltipX = Math.max(PAD.l + 6, Math.min(PAD.l + PLOT_W - tooltipW - 6, cursorX - tooltipW / 2))
  const tooltipY = cursorY > PAD.t + 62 ? cursorY - tooltipH - 14 : cursorY + 16

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * W
    const frac = Math.max(0, Math.min(1, (svgX - PAD.l) / PLOT_W))
    setHoverFrac(frac)
  }

  const body = (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-label uppercase text-text-tertiary">{c.ladderChartTitle}</span>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold tracking-tight text-brand">
                ${activePrice.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}
                <span className="ml-1.5 text-note font-normal text-text-tertiary">USDT</span>
              </span>
              <span className="rounded-pill border border-brand/30 bg-brand/10 px-2.5 py-0.5 font-mono text-micro font-medium text-brand">
                T{activeTierIdx + 1} · {activeMult.toFixed(1)}× L1
              </span>
              <span className="font-mono text-note font-normal text-text-tertiary">
                #{fmtSharesShort(activeShares)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {TIERS.map((t, i) => {
              const active = activeTierIdx === i
              return (
                <button
                  key={t.from}
                  type="button"
                  onClick={() => { setSelectedTier(i); setHoverFrac(null) }}
                  className={cn(
                    'rounded-pill border px-2.5 py-1 font-mono text-micro transition-colors',
                    active
                      ? 'border-brand/70 bg-brand/10 font-medium text-brand'
                      : 'border-border-subtle text-text-tertiary hover:border-border-strong hover:text-text-primary',
                  )}
                >
                  T{i + 1}
                </button>
              )
            })}
          </div>
        </div>

        <div className="relative overflow-hidden rounded-panel border border-border-subtle bg-bg-subtle/60 px-4 py-4 md:px-6 md:py-5">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full cursor-crosshair select-none touch-none"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            role="img"
            aria-label={c.ladderChartTitle}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoverFrac(null)}
          >
            <defs>
              <linearGradient id="ouro-ladder-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--tosh-brand)" stopOpacity="0.16" />
                <stop offset="70%" stopColor="var(--tosh-brand)" stopOpacity="0.03" />
                <stop offset="100%" stopColor="var(--tosh-brand)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="ouro-ladder-band" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--tosh-brand)" stopOpacity="0" />
                <stop offset="50%" stopColor="var(--tosh-brand)" stopOpacity="0.05" />
                <stop offset="100%" stopColor="var(--tosh-brand)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="ouro-ladder-line" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--tosh-brand)" />
                <stop offset="70%" stopColor="var(--tosh-brand-hover)" />
                <stop offset="100%" stopColor="var(--tosh-warning)" />
              </linearGradient>
            </defs>

            <rect
              x={bandX}
              y={PAD.t}
              width={segW}
              height={PLOT_H}
              fill="url(#ouro-ladder-band)"
            />

            {[4, 8, 12, 16].map(tick => {
              const y = priceToY(tick)
              return (
                <g key={tick}>
                  <line
                    x1={PAD.l}
                    y1={y}
                    x2={W - PAD.r}
                    y2={y}
                    stroke="var(--tosh-border-subtle)"
                    strokeOpacity="0.4"
                    strokeWidth="0.75"
                  />
                  <text
                    x={PAD.l - 10}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--tosh-text-quiet)"
                    fontSize="10"
                    fontWeight="400"
                    fontFamily={CHART_FONT}
                  >
                    ${tick}
                  </text>
                </g>
              )
            })}

            {chart.knots.slice(1, -1).map(k => (
              <line
                key={`v-${k.label}`}
                x1={k.x}
                y1={PAD.t}
                x2={k.x}
                y2={chart.baseY}
                stroke="var(--tosh-border-subtle)"
                strokeOpacity="0.28"
                strokeWidth="0.75"
                strokeDasharray="2 4"
              />
            ))}

            <line
              x1={PAD.l}
              y1={chart.baseY}
              x2={W - PAD.r}
              y2={chart.baseY}
              stroke="var(--tosh-border-subtle)"
              strokeOpacity="0.7"
              strokeWidth="0.75"
            />

            <line
              x1={PAD.l}
              y1={l1Y}
              x2={W - PAD.r}
              y2={l1Y}
              stroke="var(--tosh-success)"
              strokeOpacity="0.45"
              strokeWidth="0.85"
              strokeDasharray="3 4"
            />
            <text
              x={W - PAD.r + 8}
              y={l1Y + 3}
              textAnchor="start"
              fill="var(--tosh-success)"
              fontSize="10"
              fontWeight="500"
              fontFamily={CHART_FONT}
            >
              $0.90
            </text>

            <text
              x={W - PAD.r + 8}
              y={peakY + 3}
              textAnchor="start"
              fill="var(--tosh-warning)"
              fontSize="10"
              fontWeight="500"
              fontFamily={CHART_FONT}
            >
              $15.18
            </text>

            <path d={chart.areaD} fill="url(#ouro-ladder-fill)" />

            <path
              d={chart.lineD}
              fill="none"
              stroke="url(#ouro-ladder-line)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />

            {chart.knots.map(k => {
              const isEdge = k.idx === activeTierIdx || k.idx === activeTierIdx + 1
              return (
                <g key={k.label}>
                  <line
                    x1={k.x}
                    y1={chart.baseY}
                    x2={k.x}
                    y2={chart.baseY + 4}
                    stroke={isEdge ? 'var(--tosh-brand)' : 'var(--tosh-border-strong)'}
                    strokeWidth="0.75"
                  />
                  <circle
                    cx={k.x}
                    cy={k.y}
                    r={isEdge ? '2.6' : '1.8'}
                    fill="var(--tosh-bg-base)"
                    stroke={isEdge ? 'var(--tosh-brand-hover)' : 'var(--tosh-brand)'}
                    strokeWidth="1.2"
                  />
                  <text
                    x={k.x}
                    y={H - 11}
                    textAnchor={k.idx === 0 ? 'start' : k.idx === SEG_COUNT ? 'end' : 'middle'}
                    fill={isEdge ? 'var(--tosh-text-secondary)' : 'var(--tosh-text-quiet)'}
                    fontSize="10"
                    fontWeight={isEdge ? '500' : '400'}
                    fontFamily={CHART_FONT}
                  >
                    {k.label}
                  </text>
                </g>
              )
            })}

            <line
              x1={cursorX}
              y1={PAD.t}
              x2={cursorX}
              y2={chart.baseY}
              stroke="var(--tosh-brand)"
              strokeOpacity="0.38"
              strokeWidth="0.75"
              strokeDasharray="2 3"
            />
            <line
              x1={PAD.l}
              y1={cursorY}
              x2={W - PAD.r}
              y2={cursorY}
              stroke="var(--tosh-brand)"
              strokeOpacity="0.18"
              strokeWidth="0.75"
              strokeDasharray="2 3"
            />

            <circle cx={cursorX} cy={cursorY} r="7.5" fill="var(--tosh-brand)" fillOpacity="0.14" />
            <circle cx={cursorX} cy={cursorY} r="3.2" fill="var(--tosh-brand-hover)" stroke="var(--tosh-bg-base)" strokeWidth="1.5" />

            <g transform={`translate(${tooltipX.toFixed(1)}, ${tooltipY.toFixed(1)})`}>
              <rect
                width={tooltipW}
                height={tooltipH}
                rx="6"
                fill="var(--tosh-bg-base)"
                fillOpacity="0.92"
                stroke="var(--tosh-border-strong)"
                strokeWidth="0.75"
              />
              <text
                x="10"
                y="17"
                fill="var(--tosh-brand)"
                fontSize="11"
                fontWeight="500"
                fontFamily={CHART_FONT}
              >
                ${activePrice.toFixed(2)} USDT
              </text>
              <text
                x={tooltipW - 10}
                y="17"
                textAnchor="end"
                fill="var(--tosh-text-tertiary)"
                fontSize="9.5"
                fontWeight="400"
                fontFamily={CHART_FONT}
              >
                T{activeTierIdx + 1}
              </text>
              <text
                x="10"
                y="32"
                fill="var(--tosh-text-tertiary)"
                fontSize="9.5"
                fontWeight="400"
                fontFamily={CHART_FONT}
              >
                #{fmtSharesShort(activeShares)}
              </text>
              <text
                x={tooltipW - 10}
                y="32"
                textAnchor="end"
                fill="var(--tosh-success)"
                fontSize="9.5"
                fontWeight="500"
                fontFamily={CHART_FONT}
              >
                {activeMult.toFixed(1)}× L1
              </text>
            </g>
          </svg>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle/60 pt-3 text-micro text-text-tertiary">
            <span className="inline-flex items-center gap-2">
              <span className="h-px w-4 bg-success" aria-hidden />
              {c.ladderChartL1Ref}
            </span>
            <span className="font-mono">
              {c.ladderProgress}: <span className="font-medium text-text-primary">{num(minted)}</span> / 21M ({globalPct.toFixed(2)}%)
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-card border border-border-subtle">
        <table className="w-full border-collapse text-note">
          <thead>
            <tr className="bg-bg-subtle text-left text-text-tertiary">
              <th className="px-4 py-3 font-medium">{c.range}</th>
              <th className="px-4 py-3 font-medium">{c.ladderPrice}</th>
              <th className="px-4 py-3 font-medium">{c.ladderStep}</th>
              <th className="px-4 py-3 text-right font-medium">{c.ladderMultiplier}</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t, i) => {
              const here = next >= t.from && next <= t.to
              const focused = activeTierIdx === i
              const pStart = Number(formatUnits(t.start, 18))
              const pEnd = Number(formatUnits(tierEnd(t), 18))
              const multStart = (pStart / L1_PRICE_NUM).toFixed(1)
              const multEnd = (pEnd / L1_PRICE_NUM).toFixed(1)
              const barPct = Math.min(100, (pEnd / 15.18) * 100)
              return (
                <tr
                  key={t.from}
                  onMouseEnter={() => { setSelectedTier(i); setHoverFrac(null) }}
                  onMouseLeave={() => setSelectedTier(null)}
                  className={cn(
                    'border-t border-border-subtle transition-colors',
                    here ? 'bg-brand/10' : focused ? 'bg-surface-hover/45' : '',
                  )}
                >
                  <td className="px-4 py-3 font-mono">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className={cn('text-micro', focused ? 'text-brand' : 'text-text-quiet')}>T{i + 1}</span>
                      <span className="text-text-primary">{num(t.from)} – {num(t.to)}</span>
                      {here && <Badge tone="ok" pip live size="sm">{`${c.current} ${fmtPrice(ladderPrice(next))}`}</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono font-medium text-text-primary">
                    {t.step === 0n ? fmtPrice(t.start) : `${fmtPrice(t.start)} → ${fmtPrice(tierEnd(t))}`}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">
                    {t.step === 0n ? c.flat : c.stepEvery(num(t.every), fmtPrice(t.step))}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <div className="hidden h-1 w-16 overflow-hidden rounded-pill bg-surface-hover sm:block">
                        <div className="h-full rounded-pill bg-brand/85" style={{ width: `${barPct}%` }} />
                      </div>
                      <span className="min-w-[5.5rem] text-right font-mono font-medium text-brand">
                        {t.step === 0n ? `${multStart}×` : `${multStart}× → ${multEnd}×`}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  if (embedded) return body
  return <Panel title={c.ladder}>{body}</Panel>
}
