'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ArrowUpRight, Flame, Layers, Sparkles, Zap } from 'lucide-react'
import { formatUnits } from 'viem'

import { cn } from '@/components/ui'
import { TIERS, ladderPrice } from '@/lib/ouroboros/ladder'

import { useOuroCopy } from './copy'

const L1_FLAT_USDT = 0.9
const BASE_POOL_USDT = 100_000
const SLIDER_STOPS = [0, 10_000, 20_000, 100_000, 1_000_000, 5_000_000, 21_000_000] as const

function sliderToShares(pos: number): number {
  const clamped = Math.max(0, Math.min(100, pos))
  const segCount = SLIDER_STOPS.length - 1
  const scaled = (clamped / 100) * segCount
  const idx = Math.min(segCount - 1, Math.floor(scaled))
  const frac = scaled - idx
  const a = SLIDER_STOPS[idx]
  const b = SLIDER_STOPS[idx + 1]
  return Math.round(a + (b - a) * frac)
}

function sharesToSlider(shares: number): number {
  const s = Math.max(0, Math.min(21_000_000, shares))
  const segCount = SLIDER_STOPS.length - 1
  for (let i = 0; i < segCount; i++) {
    const a = SLIDER_STOPS[i]
    const b = SLIDER_STOPS[i + 1]
    if (s <= b) {
      const frac = b === a ? 0 : (s - a) / (b - a)
      return ((i + frac) / segCount) * 100
    }
  }
  return 100
}

function cumulativeL2Usdt(shares: number): number {
  if (shares <= 0) return 0
  let total = 0
  for (const t of TIERS) {
    if (shares < t.from) break
    const count = Math.min(shares, t.to) - t.from + 1
    const startNum = Number(formatUnits(t.start, 18))
    if (t.step === 0n) {
      total += count * startNum
      continue
    }
    const stepNum = Number(formatUnits(t.step, 18))
    const fullGroups = Math.floor(count / t.every)
    const rem = count % t.every
    const fullSum = fullGroups > 0
      ? t.every * (fullGroups * startNum + stepNum * ((fullGroups * (fullGroups - 1)) / 2))
      : 0
    const remSum = rem * (startNum + fullGroups * stepNum)
    total += fullSum + remSum
  }
  return total
}

function fmtUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function fmtMultiple(m: number): string {
  if (m >= 100) return `${Math.round(m).toLocaleString('en-US')}×+`
  if (m >= 10) return `${m.toFixed(1)}×`
  return `${m.toFixed(2)}×`
}

function AnimLadder() {
  const bars = [
    { x: 18, y: 66, h: 20, cls: 'ouro-step-1' },
    { x: 46, y: 54, h: 32, cls: 'ouro-step-2' },
    { x: 74, y: 42, h: 44, cls: 'ouro-step-3' },
    { x: 102, y: 28, h: 58, cls: 'ouro-step-4' },
    { x: 130, y: 14, h: 72, cls: 'ouro-step-5' },
  ]
  return (
    <svg viewBox="0 0 180 96" className="h-24 w-full" aria-hidden="true">
      <line x1="12" y1="86" x2="168" y2="86" stroke="var(--tosh-border-subtle)" strokeWidth="1" />
      <path
        d="M27,60 L55,48 L83,36 L111,22 L139,10"
        fill="none"
        stroke="var(--tosh-brand)"
        strokeWidth="1.6"
        className="ouro-dash-flow"
      />
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="18"
          height={b.h}
          rx="4"
          fill={i === 4 ? 'var(--tosh-brand-hover)' : 'var(--tosh-brand)'}
          className={b.cls}
        />
      ))}
      <circle cx="139" cy="10" r="3.5" fill="var(--tosh-brand-hover)" />
    </svg>
  )
}

function AnimPoolFill() {
  return (
    <svg viewBox="0 0 180 96" className="h-24 w-full" aria-hidden="true">
      <defs>
        <clipPath id="ouro-tank-clip">
          <rect x="44" y="34" width="92" height="52" rx="10" />
        </clipPath>
        <linearGradient id="ouro-liquid-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--tosh-success)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--tosh-success)" stopOpacity="0.14" />
        </linearGradient>
      </defs>

      <circle cx="76" cy="16" r="3.2" fill="var(--tosh-success)" className="ouro-drop-1" />
      <circle cx="90" cy="12" r="3.8" fill="var(--tosh-brand)" className="ouro-drop-2" />
      <circle cx="104" cy="16" r="3.2" fill="var(--tosh-success)" className="ouro-drop-3" />

      <g clipPath="url(#ouro-tank-clip)">
        <path
          d="M36,54 Q58,48 80,54 T124,54 T168,54 L168,90 L36,90 Z"
          fill="url(#ouro-liquid-grad)"
          className="ouro-wave"
        />
        <path
          d="M36,54 Q58,48 80,54 T124,54 T168,54"
          fill="none"
          stroke="var(--tosh-success)"
          strokeWidth="2"
          className="ouro-wave"
        />
      </g>

      <rect
        x="44"
        y="34"
        width="92"
        height="52"
        rx="10"
        fill="none"
        stroke="var(--tosh-success)"
        strokeOpacity="0.5"
        strokeWidth="1.5"
      />
      <rect x="81" y="61" width="18" height="14" rx="3" fill="var(--tosh-bg-base)" stroke="var(--tosh-brand)" strokeWidth="1.4" />
      <path d="M85,61 V57 A5,5 0 0 1 95,57 V61" fill="none" stroke="var(--tosh-brand)" strokeWidth="1.4" />
      <circle cx="90" cy="68" r="1.8" fill="var(--tosh-brand)" />
    </svg>
  )
}

function AnimBurn() {
  return (
    <svg viewBox="0 0 180 96" className="h-24 w-full" aria-hidden="true">
      <circle cx="72" cy="40" r="2.8" fill="var(--tosh-warning)" className="ouro-ember-1" />
      <circle cx="88" cy="36" r="3.4" fill="var(--tosh-brand-hover)" className="ouro-ember-2" />
      <circle cx="104" cy="42" r="2.6" fill="var(--tosh-warning)" className="ouro-ember-3" />
      <circle cx="94" cy="30" r="2.2" fill="var(--tosh-danger)" className="ouro-ember-4" />

      <ellipse cx="90" cy="76" rx="38" ry="8" fill="var(--tosh-surface-elevated)" stroke="var(--tosh-border-strong)" strokeWidth="1.2" />
      <ellipse cx="90" cy="64" rx="38" ry="8" fill="var(--tosh-surface-elevated)" stroke="var(--tosh-warning)" strokeOpacity="0.55" strokeWidth="1.2" />
      <ellipse
        cx="90"
        cy="51"
        rx="36"
        ry="7.5"
        fill="var(--tosh-warning)"
        fillOpacity="0.22"
        stroke="var(--tosh-warning)"
        strokeWidth="1.6"
        strokeDasharray="6 4"
        className="ouro-dash-flow"
      />

      <path
        d="M90,26 C96,34 99,40 95,46 C93,49 87,49 85,46 C81,40 84,34 90,26 Z"
        fill="var(--tosh-warning)"
        fillOpacity="0.85"
      />
      <path
        d="M90,34 C93,38 94,41 92,44 C91,45 89,45 88,44 C86,41 87,38 90,34 Z"
        fill="var(--tosh-brand-hover)"
      />
    </svg>
  )
}

function AnimPriceLift() {
  return (
    <svg viewBox="0 0 180 96" className="h-24 w-full" aria-hidden="true">
      <defs>
        <linearGradient id="ouro-lift-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--tosh-brand)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--tosh-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line x1="16" y1="84" x2="164" y2="84" stroke="var(--tosh-border-subtle)" strokeWidth="1" />
      <path
        d="M22,76 C56,74 96,60 152,16 L152,84 L22,84 Z"
        fill="url(#ouro-lift-area)"
      />
      <path
        d="M22,76 C56,74 96,60 152,16"
        fill="none"
        stroke="var(--tosh-brand)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M22,76 C56,74 96,60 152,16"
        fill="none"
        stroke="var(--tosh-text-primary)"
        strokeOpacity="0.6"
        strokeWidth="1.3"
        strokeLinecap="round"
        className="ouro-dash-flow"
      />
      <path
        d="M142,16 L154,15 L152,27"
        fill="none"
        stroke="var(--tosh-brand-hover)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="20" y="26" fill="var(--tosh-success)" fontSize="10.5" fontFamily="var(--font-mono)" fontWeight="700">
        USDT ↑
      </text>
      <text x="20" y="42" fill="var(--tosh-warning)" fontSize="10.5" fontFamily="var(--font-mono)" fontWeight="700">
        OURO ↓
      </text>
    </svg>
  )
}

const STEP_ANIMS = [AnimLadder, AnimPoolFill, AnimBurn, AnimPriceLift] as const

export function PriceFlywheel({
  initialShares = 100_000,
  id,
  embedded = false,
}: {
  initialShares?: number
  id?: string
  embedded?: boolean
}) {
  const c = useOuroCopy()
  const [activeStep, setActiveStep] = useState(0)
  const [burstKey, setBurstKey] = useState(0)
  const [burstNotice, setBurstNotice] = useState(false)
  const [simShares, setSimShares] = useState(initialShares)

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveStep(prev => (prev + 1) % 4)
    }, 2800)
    return () => clearInterval(timer)
  }, [])

  const triggerMintDemo = () => {
    setBurstKey(k => k + 1)
    setBurstNotice(true)
    setActiveStep(3)
    setSimShares(prev => {
      if (prev < 10_000) return 10_000
      if (prev < 100_000) return 100_000
      if (prev < 1_000_000) return 1_000_000
      if (prev < 5_000_000) return 5_000_000
      if (prev < 21_000_000) return 21_000_000
      return 10_000
    })
  }

  useEffect(() => {
    if (!burstNotice) return
    const t = setTimeout(() => setBurstNotice(false), 1800)
    return () => clearTimeout(t)
  }, [burstNotice, burstKey])

  const metrics = useMemo(() => {
    const nextShare = Math.min(21_000_000, Math.max(1, simShares))
    const tierPrice = Number(formatUnits(ladderPrice(nextShare), 18))
    const vsL1 = tierPrice / L1_FLAT_USDT
    const totalMintedUsdt = cumulativeL2Usdt(simShares)
    const addedPoolUsdt = totalMintedUsdt * 0.8
    const usdtRatio = 1 + addedPoolUsdt / BASE_POOL_USDT
    const tokenRemainingRatio = Math.pow(usdtRatio, -1.2625)
    const burnedPct = (1 - tokenRemainingRatio) * 100
    const priceMultiple = usdtRatio / tokenRemainingRatio
    const usdtBarPct = Math.min(100, 18 + Math.log10(usdtRatio) * 30)
    const tokenBarPct = Math.max(4, tokenRemainingRatio * 100)
    return {
      tierPrice,
      vsL1,
      addedPoolUsdt,
      burnedPct,
      priceMultiple,
      usdtBarPct,
      tokenBarPct,
    }
  }, [simShares])

  const sliderPos = sharesToSlider(simShares)

  const inner = (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase text-brand">{c.flywheelKicker}</span>
          <h2 className="text-section text-text-primary">
            <span className="text-gold-shimmer">{c.flywheelTitle}</span>
          </h2>
          <p className="max-w-xl text-body text-text-secondary">{c.flywheelLead}</p>
        </div>

        <button
          type="button"
          onClick={triggerMintDemo}
          className="inline-flex w-fit shrink-0 items-center gap-2 rounded-pill border border-brand bg-brand px-5 py-2.5 font-mono text-note font-bold text-bg-base shadow-armed transition-transform hover:scale-[1.02] active:scale-[0.98]"
        >
          <Zap className="size-4" aria-hidden />
          {c.flywheelTrigger}
        </button>
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-12">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {c.flywheelSteps.map((step, idx) => {
            const Anim = STEP_ANIMS[idx]
            const active = activeStep === idx
            const accentText =
              idx === 1 ? 'text-success' : idx === 2 ? 'text-warning' : 'text-brand'
            const accentBorder =
              idx === 1 ? 'border-success/55 bg-success/5'
                : idx === 2 ? 'border-warning/55 bg-warning/5'
                  : 'border-brand/55 bg-brand/5'
            return (
              <button
                key={step.num}
                type="button"
                onClick={() => setActiveStep(idx)}
                className={cn(
                  'flex flex-col justify-between gap-3 rounded-card border p-5 text-left transition-all duration-300',
                  active
                    ? cn(accentBorder, 'shadow-lift')
                    : 'border-border-subtle bg-bg-subtle/50 hover:border-border-strong',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('font-mono text-note font-bold', accentText)}>
                    {step.num} · {step.title}
                  </span>
                  <span className="font-mono text-micro text-text-tertiary">{step.short}</span>
                </div>

                <div className="py-1">
                  <Anim />
                </div>

                <span className="text-note text-text-secondary">{step.detail}</span>
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-7 lg:border-l lg:border-border-subtle lg:pl-10">
          <div className="grid grid-cols-2 gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-label uppercase text-text-tertiary">{c.simPriceIndex}</span>
              <span className="font-mono text-3xl font-bold text-brand">
                {fmtMultiple(metrics.priceMultiple)}
              </span>
              <span className="font-mono text-note text-success">
                {burstNotice ? c.flywheelTriggered : `${c.simUsdtGain} +${fmtUsdCompact(metrics.addedPoolUsdt)}`}
              </span>
            </div>

            <div className="flex flex-col gap-1.5 border-l border-border-subtle pl-6">
              <span className="font-mono text-label uppercase text-text-tertiary">{c.simTierPrice}</span>
              <span className="font-mono text-3xl font-bold text-text-primary">
                ${metrics.tierPrice.toFixed(2)}
              </span>
              <span className="font-mono text-note text-text-tertiary">
                {c.simVsL1} {metrics.vsL1.toFixed(1)}×
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-note text-text-tertiary">{c.simL2Shares}</span>
              <span className="font-mono text-readout font-bold text-text-primary">
                {simShares.toLocaleString('en-US')}
                <span className="ml-1.5 text-note font-normal text-text-quiet">/ 21M</span>
              </span>
            </div>

            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={sliderPos}
              onChange={e => setSimShares(sliderToShares(Number(e.target.value)))}
              aria-label={c.simL2Shares}
              className="h-2 w-full cursor-pointer appearance-none rounded-pill bg-surface-hover accent-brand"
            />

            <div className="flex flex-wrap gap-2">
              {c.simPresets.map(p => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setSimShares(p.shares)}
                  className={cn(
                    'rounded-pill border px-3 py-1 font-mono text-micro transition-colors',
                    simShares === p.shares
                      ? 'border-brand bg-brand/15 font-bold text-brand'
                      : 'border-border-subtle text-text-tertiary hover:border-border-strong hover:text-text-primary',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-border-subtle pt-5">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-note">
                <span className="flex items-center gap-2 text-text-secondary">
                  <Layers className="size-3.5 text-success" aria-hidden />
                  {c.simPoolUsdt}
                </span>
                <span className="font-mono font-bold text-success">+{fmtUsdCompact(metrics.addedPoolUsdt)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-pill bg-surface-hover">
                <div
                  className="ouro-bar-sheen h-full rounded-pill bg-success transition-all duration-300"
                  style={{ width: `${metrics.usdtBarPct}%` }}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-note">
                <span className="flex items-center gap-2 text-text-secondary">
                  <Flame className="size-3.5 text-warning" aria-hidden />
                  {c.simPoolToken}
                </span>
                <span className="font-mono font-bold text-warning">
                  {c.simBurnedPct} {metrics.burnedPct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-pill bg-surface-hover">
                <div
                  className="ouro-burn-glow h-full rounded-pill bg-warning transition-all duration-300"
                  style={{ width: `${metrics.tokenBarPct}%` }}
                />
              </div>
            </div>
          </div>

          <p className="text-micro text-text-quiet">{c.simDisclaimer}</p>
        </div>
      </div>
    </div>
  )

  if (embedded) return inner

  return (
    <section
      id={id}
      className="glow-frame relative overflow-hidden rounded-panel bg-surface-card/80 p-6 md:p-8"
    >
      {inner}
    </section>
  )
}

export function FlywheelMini({
  tip,
  onOpenSimulator,
}: {
  tip?: string
  onOpenSimulator?: () => void
}) {
  const c = useOuroCopy()
  const [pulse, setPulse] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setPulse(p => (p + 1) % 3), 2200)
    return () => clearInterval(t)
  }, [])

  const nodes = [
    { icon: Sparkles, label: c.flywheelSteps[0].title, sub: '1.20→15.18U', tone: 'brand' as const },
    { icon: Layers, label: c.flywheelSteps[1].title, sub: 'USDT ↑', tone: 'success' as const },
    { icon: Flame, label: c.flywheelSteps[2].title, sub: 'OURO ↓', tone: 'warning' as const },
  ]

  return (
    <section className="glow-frame flex flex-col gap-6 rounded-panel bg-surface-card/85 p-6 md:p-7">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-label uppercase text-brand">{c.flywheelMiniTitle}</h2>
        <span className="font-mono text-note font-bold text-text-primary">P = USDT ↑ / OURO ↓</span>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {nodes.map((n, i) => {
          const Icon = n.icon
          const active = pulse === i
          return (
            <div
              key={n.label}
              className={cn(
                'relative flex flex-col items-center gap-2 rounded-card border px-2 py-4 text-center transition-all duration-300',
                active
                  ? n.tone === 'success'
                    ? 'border-success/60 bg-success/10'
                    : n.tone === 'warning'
                      ? 'border-warning/60 bg-warning/10'
                      : 'border-brand/60 bg-brand/10'
                  : 'border-border-subtle bg-bg-subtle/50',
              )}
            >
              <Icon
                className={cn(
                  'size-4',
                  n.tone === 'success' ? 'text-success' : n.tone === 'warning' ? 'text-warning' : 'text-brand',
                )}
                aria-hidden
              />
              <span className="text-note font-bold text-text-primary">{n.label}</span>
              <span className="font-mono text-micro text-text-tertiary">{n.sub}</span>
              {i < 2 && (
                <ArrowRight
                  className="pointer-events-none absolute -right-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-brand/70"
                  aria-hidden
                />
              )}
            </div>
          )
        })}
      </div>

      {tip && (
        <p className="border-t border-border-subtle pt-4 text-body leading-relaxed text-text-secondary">
          {tip}
        </p>
      )}

      {onOpenSimulator && (
        <button
          type="button"
          onClick={onOpenSimulator}
          className="flex w-full items-center justify-center gap-2 rounded-input border border-brand/40 bg-brand/10 px-4 py-2.5 font-mono text-note font-bold text-brand transition-colors hover:bg-brand hover:text-bg-base"
        >
          {c.flywheelMiniCta}
          <ArrowUpRight className="size-4" aria-hidden />
        </button>
      )}
    </section>
  )
}
