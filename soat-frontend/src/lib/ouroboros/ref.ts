/**
 * Ouroboros partner referrals, settled off chain.
 *
 * A mint passes its referral code as the ef argument, which the contract
 * logs in L1Minted / L2Minted. Only the minting wallet chooses its own
 * arguments, so the indexer can attribute a mint without trusting the page
 * that built it, and a batched call from a smart account keeps the code.
 *
 *   ref = code (ASCII), zero-padded on the right to 32 bytes; zero for none
 */
import { hexToString, stringToHex, zeroHash, type Hex } from 'viem'

/** Codes are assigned by the multisig; lowercase letters and digits only. */
export const REF_CODE_RE = /^[a-z0-9]{3,16}$/

/** Most a partner link can be paid: the treasury's 20 % of every mint. */
export const MAX_REF_RATE_BPS = 2_000

export const isRefCode = (s: unknown): s is string => typeof s === 'string' && REF_CODE_RE.test(s)

export function encodeRefCode(code: string | undefined): Hex {
  if (code === undefined) return zeroHash
  if (!isRefCode(code)) throw new Error(`not a referral code: ${code}`)
  return stringToHex(code, { size: 32 })
}

/** The referral code a mint logged, or null for none or one that is not a code. */
export function decodeRefCode(ref: Hex): string | null {
  if (ref.toLowerCase() === zeroHash) return null
  const code = hexToString(ref, { size: 32 }).replace(/\0+$/, '')
  return isRefCode(code) ? code : null
}

// ── Signed requests ─────────────────────────────────────────────────────────

/** How long a signed request stays valid. */
export const REF_SIG_TTL_MS = 10 * 60_000

export type RefAction =
  | { action: 'list' }
  | { action: 'view' }
  | { action: 'createLink'; code: string; partner: string; label: string; rateBps: number }
  | { action: 'setRate'; code: string; rateBps: number }
  | { action: 'recordPayout'; txHash: string }
  /** Lets the next automatic run pay up to `maxTotal` USDT wei above the caps, once, within a day. */
  | { action: 'approvePayout'; maxTotal: string }

/** The exact text a wallet signs for `req`; the server rebuilds it from the same fields. */
export function refMessage(req: RefAction, issuedAt: number): string {
  const fields = Object.entries(req)
    .filter(([k]) => k !== 'action')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${String(v)}`)
  return ['Ouroboros referrals', `action: ${req.action}`, ...fields, `issued: ${issuedAt}`].join('\n')
}

// ── The captured link ───────────────────────────────────────────────────────

const STORE_KEY = 'ouro:ref'

export function readStoredRef(): string | undefined {
  try {
    const v = window.localStorage.getItem(STORE_KEY) ?? ''
    return isRefCode(v) ? v : undefined
  } catch {
    return undefined
  }
}

export function storeRef(code: string) {
  try { window.localStorage.setItem(STORE_KEY, code) } catch { /* storage blocked */ }
}
