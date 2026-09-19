import { formatUnits } from 'viem'
import { testnetExplorerTx, QUOTE_DECIMALS } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function fmt(wei: bigint | null | undefined, dec = 18, precision = 4): string {
  if (wei === null || wei === undefined) return '—'
  try {
    const s = formatUnits(wei, dec)
    const n = parseFloat(s)
    if (n === 0)        return '0'
    if (n < 0.0001)     return n.toExponential(2)
    if (n >= 1e9)       return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6)       return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3)       return (n / 1e3).toFixed(2) + 'K'
    return n.toLocaleString('en-US', { maximumFractionDigits: precision })
  } catch { return '0' }
}

export function fmtFull(wei: bigint | null | undefined, dec = 18): string {
  if (wei === null || wei === undefined) return '—'
  try { return formatUnits(wei, dec) } catch { return '0' }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ASSETS, TWO SCALES, AND A DEFAULT THAT IS NOW WRONG HALF THE TIME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `fmt` and `fmtFull` default to 18 decimals because everything they were written
 * for had 18: the project token, and a quote asset that was the native coin.
 * Moving the quote asset to an 8-decimal ERC-20 split that population in two, and
 * left the default silently correct for one half and silently wrong for the other.
 *
 * Wrong in a way worth spelling out. `fmt(928_00000000n)` — a 9.28 launch fee —
 * renders as `9.28e-8` under the 18-decimal default. It does not throw, does not
 * warn, and does not look like a unit error: it looks like a very small number,
 * which is a perfectly plausible thing for a fee to be. Every quote figure on
 * every panel would have been understated by a factor of 10^10 and read as
 * plausible.
 *
 * The fix is not to change the default, which would flip the error onto the token
 * amounts instead. It is to stop calling the unqualified function for quote
 * amounts at all. `fmtQuote` names its asset, so a call site that formats a raise,
 * a fee, a cap, a shelf price or a treasury balance says which scale it means, and
 * a reviewer can see a mistake instead of having to know the value's provenance.
 * `fmt` keeps its 18-decimal default for token amounts, where it was always right.
 */

/** A quote-asset amount — raises, fees, caps, shelf prices, treasury balances. */
export function fmtQuote(units: bigint | null | undefined, precision = 4): string {
  return fmt(units, QUOTE_DECIMALS, precision)
}

/** A quote-asset amount, unabbreviated, for the `hint` line under a readout. */
export function fmtQuoteFull(units: bigint | null | undefined): string {
  return fmtFull(units, QUOTE_DECIMALS)
}

export function basescanTx(hash: string) {
  return testnetExplorerTx(hash)
}
