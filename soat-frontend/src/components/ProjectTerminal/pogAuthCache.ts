import { POG_SESSION_AUTH_TTL_MS } from '@/lib/contracts'

// ── Session auth cache (matches API route's SESSION_AUTH_TTL_MS) ─────────────
export interface PogAuthCache { signature: `0x${string}`; timestamp: number }

export function pogAuthCacheKey(address: string): string {
  return `tosh_pog_auth_${address.toLowerCase()}`
}

export function readPogAuthCache(address: string): PogAuthCache | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(pogAuthCacheKey(address))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PogAuthCache
    if (
      typeof parsed.timestamp !== 'number' ||
      typeof parsed.signature !== 'string' ||
      !parsed.signature.startsWith('0x')
    ) return null
    if (Date.now() - parsed.timestamp >= POG_SESSION_AUTH_TTL_MS) return null
    return parsed
  } catch { return null }
}

export function writePogAuthCache(address: string, data: PogAuthCache): void {
  if (typeof window === 'undefined') return
  try { sessionStorage.setItem(pogAuthCacheKey(address), JSON.stringify(data)) }
  catch { /* private mode etc — scan still works, just no cache */ }
}
