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

/** Most a partner link can be paid for one full Agent ID: 10,000 USDT, in wei (18 decimals). */
export const MAX_REF_BONUS_WEI = 10_000n * 10n ** 18n

/** Invite-contest season reward: 5 USDT per full Agent ID, in wei. */
export const SEASON_REF_BONUS_WEI = (5n * 10n ** 18n).toString()

export const isRefCode = (s: unknown): s is string => typeof s === 'string' && REF_CODE_RE.test(s)

const REF_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A random code for a new partner link (default 8 chars; length must be 3–16). */
export function randomRefCode(length = 8): string {
  if (length < 3 || length > 16) throw new Error(`referral code length must be 3–16, got ${length}`)
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += REF_CODE_ALPHABET[b % REF_CODE_ALPHABET.length]!
  return out
}

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

/** Read-only requests (`list`, `view`) are cached by the page and stay valid longer. */
export const REF_READ_SIG_TTL_MS = 24 * 60 * 60_000

export const refSigTtl = (req: RefAction) =>
  req.action === 'list' || req.action === 'view' ? REF_READ_SIG_TTL_MS : REF_SIG_TTL_MS

export type RefAction =
  | { action: 'list' }
  | { action: 'view' }
  /** Public: wallet applies for a partner code; payout address is the signer. */
  | { action: 'apply'; code: string; label: string }
  /** Admin: activate a pending application; `bonus` is USDT wei per full Agent ID. */
  | { action: 'approveApplication'; id: number; bonus: string }
  | { action: 'rejectApplication'; id: number; reason: string }
  /** `bonus` is USDT wei, a decimal string. */
  | { action: 'createLink'; code: string; partner: string; label: string; bonus: string }
  | { action: 'setBonus'; code: string; bonus: string }
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
