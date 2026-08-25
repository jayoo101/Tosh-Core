import { formatUnits } from 'viem'
import { testnetExplorerTx } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function fmt(wei: bigint | undefined, dec = 18, precision = 4): string {
  if (wei === undefined) return '—'
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

export function fmtFull(wei: bigint | undefined, dec = 18): string {
  if (wei === undefined) return '—'
  try { return formatUnits(wei, dec) } catch { return '0' }
}

export function basescanTx(hash: string) {
  return testnetExplorerTx(hash)
}
