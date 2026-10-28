'use client'

import { fill, useT } from '@/i18n'
import { SALE_TOKENS, fmtCompact, fmtPrice, priceAt } from './curve'

const W = 640
const H = 240
const PAD = { l: 8, r: 8, t: 20, b: 28 }

/** P to 1.5P over the sale supply, with the sold part filled and the 2P launch line dashed. */
export function GenesisCurveChart({ p, sold, quote }: { p: number; sold: number; quote: string }) {
  const t = useT().x
  const maxY = 2.15 * p
  const minY = 0.85 * p
  const x = (s: number) => PAD.l + (Math.min(s, SALE_TOKENS) / SALE_TOKENS) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - minY) / (maxY - minY)) * (H - PAD.t - PAD.b)

  const cx = x(sold)
  const cy = y(priceAt(sold, p))
  const openY = y(2 * p)

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={fill(t.curveAria, {
          p: fmtPrice(p), p15: fmtPrice(1.5 * p), p2: fmtPrice(2 * p), quote,
          sold: fmtCompact(sold), total: fmtCompact(SALE_TOKENS),
        })}
      >
        <line x1={PAD.l} x2={W - PAD.r} y1={openY} y2={openY} className="stroke-text-primary/60" strokeDasharray="6 6" />
        <text x={W - PAD.r} y={openY - 8} textAnchor="end" className="fill-text-primary font-mono text-[13px]">
          {fill(t.launchAt2P, { p: fmtPrice(2 * p) })}
        </text>

        <path d={`M${x(0)},${y(p)} L${cx},${cy} L${cx},${H - PAD.b} L${x(0)},${H - PAD.b} Z`} className="fill-brand/15" />
        <line x1={x(0)} y1={y(p)} x2={cx} y2={cy} className="stroke-brand" strokeWidth={3} />
        <line x1={cx} y1={cy} x2={x(SALE_TOKENS)} y2={y(1.5 * p)} className="stroke-text-tertiary" strokeWidth={2} strokeDasharray="4 6" />
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="stroke-border-subtle" />

        <circle cx={cx} cy={cy} r={10} className="fill-brand/25" />
        <circle cx={cx} cy={cy} r={5} className="fill-brand" />

        <text x={x(0)} y={y(p) - 10} className="fill-text-tertiary font-mono text-[13px]">{`P ${fmtPrice(p)}`}</text>
        <text x={x(SALE_TOKENS)} y={y(1.5 * p) - 10} textAnchor="end" className="fill-text-tertiary font-mono text-[13px]">
          {`1.5P ${fmtPrice(1.5 * p)}`}
        </text>
        <text x={x(0)} y={H - 8} className="fill-text-tertiary font-mono text-[12px]">0</text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" className="fill-text-tertiary font-mono text-[12px]">
          {fill(t.curveSoldAxis, { total: fmtCompact(SALE_TOKENS) })}
        </text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-note text-text-tertiary">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 bg-brand" aria-hidden="true" />
          {t.curveSold}
        </span>
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-text-tertiary" aria-hidden="true" />
          {t.curveRemaining}
        </span>
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-text-primary/60" aria-hidden="true" />
          {t.curveLaunch}
        </span>
      </figcaption>
    </figure>
  )
}

/** P, now, 1.5P and 2P on one track, so "how far am I from launch" reads at a glance. */
export function PriceLadderMini({ p, current, quote }: { p: number; current: number; quote: string }) {
  const t = useT().x
  const points = [
    { label: 'P', value: p, active: false },
    { label: t.ladderNow, value: current, active: true },
    { label: '1.5P', value: 1.5 * p, active: false },
    { label: t.curveLaunch, value: 2 * p, active: false },
  ]
  const pos = (v: number) => (p > 0 ? ((v - p) / p) * 100 : 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-1.5 rounded-pill bg-surface-hover">
        <div className="absolute inset-y-0 left-0 rounded-pill bg-brand" style={{ width: `${pos(current)}%` }} />
        {points.map(pt => (
          <span
            key={pt.label}
            className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-pill border-2 ${
              pt.active ? 'border-brand bg-bg-base' : 'border-text-tertiary bg-surface-card'
            }`}
            style={{ left: `${pos(pt.value)}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
      <dl className="grid grid-cols-4 gap-2">
        {points.map(pt => (
          <div key={pt.label} className="flex flex-col gap-0.5">
            <dt className={`text-note ${pt.active ? 'text-brand' : 'text-text-tertiary'}`}>{pt.label}</dt>
            <dd className="font-mono text-readout text-text-primary">
              {fmtPrice(pt.value)}
              <span className="sr-only"> {quote}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
