'use client'

/**
 * The quote asset of the project on screen.
 *
 * The site lists launches from more than one factory, and the factories are
 * denominated in different assets: WBNB (18 decimals) on the current one, BEM
 * (8) on the retired ones. Every project-scoped figure — raise, price, refund,
 * claim, LP depth — must be read at its own hook's scale, so panels take the
 * asset from here rather than from the `QUOTE_*` module constants, which describe
 * the current factory only.
 *
 * The default is the current factory, so a panel rendered outside a provider
 * (the launch page, tests) behaves exactly as it did before.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { parseUnits } from 'viem'
import { CURRENT_QUOTE, type QuoteConfig } from '@/lib/contracts'
import { fmtQuote, fmtQuoteFull } from './format'

const QuoteContext = createContext<QuoteConfig>(CURRENT_QUOTE)

export function QuoteProvider({ value, children }: { value: QuoteConfig; children: ReactNode }) {
  return <QuoteContext.Provider value={value}>{children}</QuoteContext.Provider>
}

export interface QuoteView extends QuoteConfig {
  /** Compact readout at this asset's scale — the project-scoped `fmtQuote`. */
  fmt: (units: bigint | null | undefined, precision?: number) => string
  /** Unabbreviated, for a hint line. */
  fmtFull: (units: bigint | null | undefined) => string
  /** User input to base units; -1n for anything unparseable. */
  parse: (raw: string) => bigint
}

export function useQuote(): QuoteView {
  const q = useContext(QuoteContext)
  return useMemo(() => ({
    ...q,
    fmt: (units, precision = 4) => fmtQuote(units, precision, q.decimals),
    fmtFull: (units) => fmtQuoteFull(units, q.decimals),
    parse: (raw) => { try { return parseUnits(raw, q.decimals) } catch { return -1n } },
  }), [q])
}
