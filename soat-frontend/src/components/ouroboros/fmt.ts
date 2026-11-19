import { formatUnits, parseUnits } from 'viem'

/** Fixed-point amount with grouping, trimmed to `digits` decimals. */
export function fmt(wei: bigint, digits = 4): string {
  const n = Number(formatUnits(wei, 18))
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** Compact amount for large token figures: 1.23B, 45.6M. */
export function fmtCompact(wei: bigint): string {
  const n = Number(formatUnits(wei, 18))
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'

/**
 * Price with enough significant digits to read a sub-cent quote. Below 0.0001
 * the run of zeros is folded into a subscript count, `0.0₈72` for 0.0000000072,
 * the notation DEX screeners use.
 */
export function fmtPrice(wei: bigint): string {
  const n = Number(formatUnits(wei, 18))
  if (n === 0) return '0'
  if (n >= 0.0001) return n.toLocaleString('en-US', { maximumSignificantDigits: 6 })
  const zeros = Math.ceil(-Math.log10(n)) - 1
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().replace(/0+$/, '') || '0'
  const sub = zeros.toString().split('').map(d => SUBSCRIPT[Number(d)]).join('')
  return `0.0${sub}${digits}`
}

/** Parses a decimal string to 18-decimal wei; `undefined` for anything malformed. */
export function parseAmount(s: string): bigint | undefined {
  const t = s.trim()
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return undefined
  try {
    return parseUnits(t, 18)
  } catch {
    return undefined
  }
}

/** USDT wei per whole token at the pool's reserves. */
export function poolPrice(reserveUsdt: bigint, reserveToken: bigint): bigint {
  return reserveToken === 0n ? 0n : (reserveUsdt * 10n ** 18n) / reserveToken
}

/** The opening price `seedPool` applies: the signer's, unless below L1's or the L1.5 volume fell short. */
export function openingPrice(requested: bigint, l1Price: bigint, volumeMet: boolean): bigint {
  return volumeMet && requested > l1Price ? requested : l1Price
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
