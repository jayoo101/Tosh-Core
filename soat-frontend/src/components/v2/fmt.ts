import { formatUnits, parseUnits } from 'viem'

/**
 * Up to `sig` significant digits, without scientific notation. GENESIS prices
 * sit around 1e-5 BNB per token, where a fixed decimal count prints `0.0000`.
 */
export function fmtSig(x: bigint | undefined | null, decimals = 18, sig = 4): string {
  if (x === undefined || x === null) return '—'
  if (x === 0n) return '0'
  const s = formatUnits(x, decimals)
  const n = Number(s)
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: sig })
  const [, frac = ''] = s.split('.')
  const lead = frac.match(/^0*/)?.[0].length ?? 0
  return `0.${frac.slice(0, lead + sig).replace(/0+$/, '')}`
}

/** A user-typed decimal, or null when it is not one. */
export function parseAmount(raw: string, decimals = 18): bigint | null {
  const v = raw.trim()
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') return null
  try {
    return parseUnits(v, decimals)
  } catch {
    return null
  }
}

/**
 * Code the contracts refuse before launch: anything except none at all or an
 * EIP-7702 designator (`0xef0100 ‖ delegate`, 23 bytes). Mirrors `WalletLib`.
 */
export function isContractCode(code: string | undefined): boolean {
  if (code === undefined || code === '0x') return false
  return !(code.length === 48 && code.toLowerCase().startsWith('0xef0100'))
}

export function fmtTime(unixSeconds: bigint | number): string {
  const ms = Number(unixSeconds) * 1000
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return '0s'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}
