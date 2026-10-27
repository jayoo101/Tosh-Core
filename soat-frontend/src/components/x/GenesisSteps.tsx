'use client'

import { useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'

import { fill, useT } from '@/i18n'

type Phase = 'wallet' | 'buy'

const BINANCE_WALLET_INVITE = 'https://web3.binance.com/referral?ref=TOSHX'

/**
 * Getting an Agent ID (an invite into Binance Wallet), then buying with it. The buy list is
 * about Agent mode, not connecting: the Agentic Wallet that holds the Agent ID
 * cannot connect to a website, so the purchase is signed by the agent.
 */
export function GenesisSteps({ symbol, quote, cap, activeBuyStep, needsAgentId }: {
  symbol: string
  quote: string
  cap: string
  activeBuyStep: number
  needsAgentId: boolean
}) {
  const t = useT().x
  const [phase, setPhase] = useState<Phase | null>(null)
  const current: Phase = phase ?? (needsAgentId ? 'wallet' : 'buy')

  const steps = [
    [t.buyStep1, t.buyStep1Body],
    [t.buyStep2, fill(t.buyStep2Body, { cap, quote })],
    [t.buyStep3, t.buyStep3Body],
    [t.buyStep4, t.buyStep4Body],
    [fill(t.buyStep5, { symbol }), t.buyStep5Body],
  ]
  const active = activeBuyStep

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-base/60 p-4">
      <div role="tablist" aria-label={t.stepsLabel} className="grid grid-cols-2 gap-1 rounded-input bg-surface-hover/70 p-1">
        {([['wallet', t.stepsWallet], ['buy', fill(t.stepsBuy, { symbol })]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={current === id}
            onClick={() => setPhase(id)}
            className={`rounded-input px-2 py-1.5 text-note font-bold transition-colors ${
              current === id ? 'bg-brand text-bg-base' : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {current === 'wallet' ? (
        <div className="flex flex-col gap-3" role="tabpanel">
          <p className="text-pretty text-note text-text-tertiary">{t.walletInvite}</p>
          <a
            href={BINANCE_WALLET_INVITE}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-input bg-brand px-4 py-2.5 text-body font-bold text-bg-base transition-opacity hover:opacity-90"
          >
            {t.walletInviteCta}
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </div>
      ) : (
        <ol className="flex flex-col" role="tabpanel">
          {steps.map(([title, body], i) => {
            const done = i < active
            const isActive = i === active
            const last = i === steps.length - 1
            return (
              <li key={title} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-pill font-mono text-note font-bold transition-colors ${
                      done
                        ? 'bg-brand/20 text-brand'
                        : isActive
                          ? 'bg-brand text-bg-base shadow-[0_0_16px_var(--tosh-brand-glow)]'
                          : 'border border-border-subtle bg-surface-card text-text-tertiary'
                    }`}
                    aria-hidden="true"
                  >
                    {done ? <Check className="size-3.5" /> : String(i + 1).padStart(2, '0')}
                  </span>
                  {!last && <span className={`w-px flex-1 ${done ? 'bg-brand/50' : 'bg-border-subtle'}`} aria-hidden="true" />}
                </div>
                <div className={`flex flex-col gap-0.5 ${last ? '' : 'pb-4'}`}>
                  <span className={`text-body font-bold ${isActive ? 'text-brand' : 'text-text-primary'}`}>
                    {title}
                    {isActive && <span className="sr-only"> {t.stepCurrent}</span>}
                  </span>
                  <span className="text-pretty text-note text-text-tertiary">{body}</span>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {current === 'wallet' && (
        <button type="button" onClick={() => setPhase('buy')} className="w-fit text-note font-bold text-brand hover:underline">
          {fill(t.stepsNext, { symbol })}
        </button>
      )}
    </div>
  )
}
