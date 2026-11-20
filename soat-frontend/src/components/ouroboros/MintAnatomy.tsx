'use client'

import { useEffect, useState } from 'react'
import { Flame, Layers, Lock, Sparkles, TrendingUp } from 'lucide-react'

import { cn } from '@/components/ui'

import { useOuroCopy } from './copy'

const SHARE_OPTIONS = [1, 5, 10, 30] as const

const TIER_OPTIONS = [
  { tag: 'T1', price: 1.2 },
  { tag: 'T3', price: 2.7 },
  { tag: 'T5', price: 6.8 },
  { tag: 'T6', price: 15.18 },
] as const

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function MintAnatomy() {
  const c = useOuroCopy()
  const [shares, setShares] = useState<number>(10)
  const [tierIdx, setTierIdx] = useState<number>(0)
  const [stage, setStage] = useState<number>(0)

  useEffect(() => {
    const t = setInterval(() => {
      setStage(prev => (prev + 1) % 3)
    }, 2600)
    return () => clearInterval(t)
  }, [])

  const unitPrice = TIER_OPTIONS[tierIdx].price
  const totalPay = shares * unitPrice
  const toPool = totalPay * 0.8
  const toTreasury = totalPay * 0.2
  const userValue = totalPay * 1.01
  const burnValue = userValue

  return (
    <div className="flex flex-col gap-9">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-label uppercase text-brand">{c.anatomyKicker}</span>
        <h2 className="text-section text-text-primary">{c.anatomyTitle}</h2>
        <p className="max-w-2xl text-body text-text-tertiary">{c.anatomyLead}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-6 border-y border-border-subtle py-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-label uppercase text-text-tertiary">{c.anatomySharesLabel}</span>
          <div className="flex gap-1.5">
            {SHARE_OPTIONS.map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setShares(n)}
                className={cn(
                  'rounded-pill border px-3.5 py-1.5 font-mono text-note font-bold transition-colors',
                  shares === n
                    ? 'border-brand bg-brand text-bg-base'
                    : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary',
                )}
              >
                {n}{c.anatomyShareUnit ? ` ${c.anatomyShareUnit}` : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-label uppercase text-text-tertiary">{c.anatomyTierLabel}</span>
          <div className="flex gap-1.5">
            {TIER_OPTIONS.map((t, i) => (
              <button
                key={t.tag}
                type="button"
                onClick={() => setTierIdx(i)}
                className={cn(
                  'rounded-pill border px-3.5 py-1.5 font-mono text-note transition-colors',
                  tierIdx === i
                    ? 'border-brand bg-brand/15 font-bold text-brand'
                    : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary',
                )}
              >
                {t.tag} · ${t.price}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative grid gap-6 lg:grid-cols-3 lg:gap-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 lg:block"
        >
          <svg viewBox="0 0 900 24" className="h-6 w-full" preserveAspectRatio="none">
            <line
              x1="280"
              y1="12"
              x2="320"
              y2="12"
              stroke="var(--tosh-brand)"
              strokeWidth="2"
              className="ouro-dash-flow"
            />
            <line
              x1="580"
              y1="12"
              x2="620"
              y2="12"
              stroke="var(--tosh-warning)"
              strokeWidth="2"
              className="ouro-dash-flow"
            />
          </svg>
        </div>

        <article
          onClick={() => setStage(0)}
          className={cn(
            'relative z-10 flex cursor-pointer flex-col justify-between gap-6 rounded-panel border p-6 transition-all duration-300',
            stage === 0
              ? 'border-brand/60 bg-bg-subtle/90 shadow-lift'
              : 'border-border-subtle bg-bg-subtle/45 hover:border-border-strong',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-label uppercase text-brand">{c.anatomyCol1}</span>
            <span className={cn('size-2 rounded-pill', stage === 0 ? 'dot-breathe bg-brand text-brand' : 'bg-border-strong')} />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-note text-text-tertiary">{c.anatomyPayTotal}</span>
            <span className="font-mono text-3xl font-bold text-text-primary">{fmtMoney(totalPay)}</span>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex h-2.5 overflow-hidden rounded-pill bg-surface-hover">
              <div className="ouro-bar-sheen h-full w-[80%] bg-success" />
              <div className="h-full w-[20%] bg-border-strong" />
            </div>
            <div className="flex items-center justify-between text-note">
              <span className="font-mono text-success">{c.anatomyToPool}</span>
              <span className="font-mono font-bold text-success">{fmtMoney(toPool)}</span>
            </div>
            <div className="flex items-center justify-between text-note">
              <span className="text-text-tertiary">{c.anatomyToTreasury}</span>
              <span className="font-mono text-text-secondary">{fmtMoney(toTreasury)}</span>
            </div>
          </div>
        </article>

        <article
          onClick={() => setStage(1)}
          className={cn(
            'relative z-10 flex cursor-pointer flex-col justify-between gap-6 rounded-panel border p-6 transition-all duration-300',
            stage === 1
              ? 'border-warning/60 bg-bg-subtle/90 shadow-lift'
              : 'border-border-subtle bg-bg-subtle/45 hover:border-border-strong',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-label uppercase text-warning">{c.anatomyCol2}</span>
            <span className={cn('size-2 rounded-pill', stage === 1 ? 'dot-breathe bg-warning text-warning' : 'bg-border-strong')} />
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-note text-text-secondary">
                <Layers className="size-4 text-success" aria-hidden />
                {c.anatomyPoolUsdtIn}
              </span>
              <span className="font-mono text-figure text-success">+{fmtMoney(toPool)}</span>
            </div>

            <div className="flex items-baseline justify-between gap-3 border-t border-border-subtle pt-4">
              <span className="inline-flex items-center gap-2 text-note text-text-secondary">
                <Flame className="size-4 text-warning" aria-hidden />
                {c.anatomyPoolBurn}
              </span>
              <span className="font-mono text-figure text-warning">≈ {fmtMoney(burnValue)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-border-subtle pt-4 font-mono text-micro text-text-tertiary">
            <Lock className="size-3.5 text-brand" aria-hidden />
            <span>{c.anatomyPoolLp}</span>
          </div>
        </article>

        <article
          onClick={() => setStage(2)}
          className={cn(
            'relative z-10 flex cursor-pointer flex-col justify-between gap-6 overflow-hidden rounded-panel border p-6 transition-all duration-300',
            stage === 2
              ? 'border-brand/65 bg-brand/10 shadow-lift'
              : 'border-border-subtle bg-bg-subtle/45 hover:border-border-strong',
          )}
        >
          {stage === 2 && (
            <div
              aria-hidden="true"
              className="ouro-rise-beam pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-brand/15 to-transparent"
            />
          )}

          <div className="relative z-10 flex items-center justify-between gap-2">
            <span className="font-mono text-label uppercase text-brand">{c.anatomyCol3}</span>
            <span className={cn('size-2 rounded-pill', stage === 2 ? 'dot-breathe bg-success text-success' : 'bg-border-strong')} />
          </div>

          <div className="relative z-10 flex flex-col gap-1.5">
            <span className="text-note text-text-tertiary">{c.anatomyUserGet}</span>
            <span className="font-mono text-3xl font-bold text-brand">{fmtMoney(userValue)}</span>
            <span className="inline-flex w-fit items-center gap-1 font-mono text-micro text-success">
              <Sparkles className="size-3" aria-hidden />
              {c.anatomyBonusTag}
            </span>
          </div>

          <div className="relative z-10 flex items-center justify-between gap-2 border-t border-border-subtle pt-4 font-mono text-note font-bold text-text-primary">
            <span className="inline-flex items-center gap-1.5 text-brand">
              <TrendingUp className="size-4" aria-hidden />
              {c.anatomyPriceLift}
            </span>
            <span className="text-success">USDT ↑ / OURO ↓</span>
          </div>
        </article>
      </div>

      <dl className="grid gap-6 border-t border-border-subtle pt-6 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-micro uppercase text-text-tertiary">{c.anatomyRule1K}</dt>
          <dd className="font-mono text-readout font-bold text-text-primary">{c.anatomyRule1V}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-micro uppercase text-text-tertiary">{c.anatomyRule2K}</dt>
          <dd className="font-mono text-readout font-bold text-brand">{c.anatomyRule2V}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-micro uppercase text-text-tertiary">{c.anatomyRule3K}</dt>
          <dd className="font-mono text-readout font-bold text-text-primary">{c.anatomyRule3V}</dd>
        </div>
      </dl>
    </div>
  )
}
