'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — client-side referral binding.
//
// `ToshFactory.globalReferrers` binds a wallet to its referrer ONCE, on that
// wallet's first genesis deposit, platform-wide and forever.  This module is
// the browser half of that contract:
//
//   • `?ref=<address>` is captured on ANY page load — see `<ReferralCapture/>`
//     in the root layout — and parked in localStorage, because the deposit
//     that finally spends it may happen hours later on a different project.
//     Capture cannot filter self-referral, because a first-time visitor
//     usually has no wallet connected yet.
//   • First link wins, exactly like the on-chain registry — a later `?ref=`
//     never overwrites a binding that is already sitting in storage.
//   • Self-referral is caught at spend time instead, and the stored value is
//     cleared rather than merely ignored.  Clicking your own link is a normal
//     way to check that it works; leaving it parked would let that one click
//     permanently occupy the slot and lock out every real referrer, since the
//     wallet only ever gets one binding.
//
// What this module deliberately does NOT check: whether the referrer is
// eligible.  `_recordReferral` also requires `pogQuota[referrer] > 0` — a
// referrer must hold their own oracle attestation, which is what stops the
// programme from being a 10 % self-rebate for anyone willing to open a second
// wallet.  An ineligible referrer is rejected silently on-chain: the deposit
// still succeeds (a stale link must never brick one), the binding just does not
// happen and the commission falls through to the buyback reservoir.  Checking
// it here would mean an extra RPC read on every page load to change nothing
// about the outcome, so the surface that matters is the SHARE side — see
// `buildReferralLink` — where a user needs to know their link will not pay
// until they have registered PoG themselves.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import { ZERO_ADDRESS } from './contracts'
import { isRefCodeShape } from './refCode'

const STORAGE_KEY = 'tosh_referrer'
const QUERY_PARAM = 'ref'

function readStoredReferrer(): Address | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || !isAddress(raw)) return null
    return getAddress(raw)
  } catch { return null }
}

function writeStoredReferrer(addr: Address): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, addr) }
  catch { /* private mode — the link still works for this session */ }
}

function clearStoredReferrer(): void {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* nothing to do */ }
}

/** Parse `?ref=` off the current URL, returning null when absent or malformed. */
function readReferrerParam(): Address | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = new URLSearchParams(window.location.search).get(QUERY_PARAM)
    if (!raw || !isAddress(raw)) return null
    return getAddress(raw)
  } catch { return null }
}

/**
 * Park `?ref=` from the current URL, if this visitor is not already bound.
 *
 * Deliberately address-blind so it can run in the root layout before a wallet
 * is connected.  Self-referral is sorted out later by `useBoundReferrer`.
 */
export function captureReferrerFromUrl(): void {
  if (readStoredReferrer()) return
  const fromUrl = readReferrerParam()
  if (fromUrl) writeStoredReferrer(fromUrl)
}

/**
 * The referrer to spend RIGHT NOW, read straight from storage.
 *
 * `useBoundReferrer` below only publishes its value from an effect, so the
 * first client frame after mount still reads `ZERO_ADDRESS`. A deposit signed
 * in that frame burns the wallet's one and only binding on nobody. Callers that
 * are about to send `factory.deposit` resolve the address here instead of
 * trusting the rendered prop.
 */
export function resolveReferrerNow(userAddress: Address | undefined): Address {
  const stored = readStoredReferrer()
  if (!stored) return ZERO_ADDRESS
  if (userAddress && stored.toLowerCase() === userAddress.toLowerCase()) {
    clearStoredReferrer()
    return ZERO_ADDRESS
  }
  return stored
}

/**
 * The referrer to display, and the capture side-effect.
 *
 * Returns `ZERO_ADDRESS` when nobody referred this visitor — the factory reads
 * that as "no referral" and sweeps the commission to the buyback reservoir
 * instead of accruing it to a claimant.
 */
export function useBoundReferrer(userAddress: Address | undefined): Address {
  const [referrer, setReferrer] = useState<Address>(ZERO_ADDRESS)

  useEffect(() => {
    captureReferrerFromUrl()

    const stored = readStoredReferrer()
    if (!stored) return

    if (userAddress && stored.toLowerCase() === userAddress.toLowerCase()) {
      clearStoredReferrer()
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReferrer(ZERO_ADDRESS)
      return
    }

    setReferrer(stored)
  }, [userAddress])

  return referrer
}

/**
 * The long form: the current page with `?ref=<address>` on it.
 *
 * Still the canonical link and still the fallback — `/r/<code>` resolves to
 * exactly this URL — so it is what the panel shows whenever a short code
 * cannot be minted. Roughly a hundred characters of path and query on a
 * project page, which is why `buildShortReferralLink` exists.
 */
export function buildReferralLink(userAddress: Address): string {
  if (typeof window === 'undefined') return ''
  const url = new URL(window.location.href)
  url.searchParams.set(QUERY_PARAM, userAddress)
  url.hash = ''
  return url.toString()
}

/**
 * The short form: `https://host/r/swift-amber-otter?p=RHRSL`.
 *
 * Built from the current ORIGIN rather than the current href, because the code
 * already carries the referrer and `?p=` already carries the destination —
 * inheriting the present path as well would put a third copy of the same
 * information in a link whose entire purpose is to be short.
 *
 * `symbol` is optional and advisory. `/r/[code]` falls back to the directory
 * when it cannot resolve one, so a wrong or unknown ticker costs a landing
 * page and never the referral.
 */
export function buildShortReferralLink(code: string, symbol?: string): string {
  if (typeof window === 'undefined') return ''
  const url = new URL(`/r/${code}`, window.location.origin)
  if (symbol) url.searchParams.set('p', symbol)
  return url.toString()
}

/** `unavailable` means the long link is what the user should be given. */
export type RefCodeState = 'idle' | 'loading' | 'ready' | 'unavailable'

/**
 * This wallet's permanent short code, minting it on first ask.
 *
 * POST rather than GET because the first call creates the row — but it is
 * idempotent by construction: `referral_codes.address` is UNIQUE and the route
 * upserts on it, so every later call returns the same three words. That
 * matters more than it sounds. A code that changed between visits would leave
 * every link already pasted somewhere still working but no longer matching
 * what this panel displays, and a referral link's whole job is to keep working
 * after it has left.
 *
 * Failure is not an error state worth showing. The long `?ref=<address>` link
 * is always available and binds identically, so the panel silently falls back
 * to it rather than telling the user that a cosmetic service is down.
 */
export function useReferralCode(userAddress: Address | undefined): {
  code: string | null
  state: RefCodeState
} {
  // ONE PIECE OF STATE, AND IT REMEMBERS WHOSE ANSWER IT IS.
  //
  // The obvious shape is a `code` and a `state`, with the effect setting
  // `'loading'` on the way in. That synchronous set inside an effect is what
  // `react-hooks/set-state-in-effect` objects to, and the rule is right about
  // more than cascading renders here: two separate states let the hook hold a
  // code for the PREVIOUS wallet while loading the next one, so switching
  // accounts flashes someone else's referral link. Stamping the answer with
  // the address it belongs to makes that unrepresentable, and lets both
  // `state` and `code` be derived below instead of stored.
  const [answer, setAnswer] = useState<{ address: Address; code: string | null } | null>(null)

  useEffect(() => {
    if (!userAddress) return

    let cancelled = false

    void fetch('/api/ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: userAddress }),
    })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { code?: unknown }) => {
        if (cancelled) return
        // Shape-checked on arrival. This string goes straight into a URL the
        // user is about to broadcast, so it is validated rather than trusted
        // for having come from our own route.
        const ok = typeof body.code === 'string' && isRefCodeShape(body.code)
        setAnswer({ address: userAddress, code: ok ? (body.code as string) : null })
      })
      .catch(() => {
        if (cancelled) return
        setAnswer({ address: userAddress, code: null })
      })

    return () => { cancelled = true }
  }, [userAddress])

  const mine = answer && answer.address === userAddress ? answer : null

  const state: RefCodeState =
    !userAddress ? 'idle'
      : mine === null ? 'loading'
        : mine.code ? 'ready' : 'unavailable'

  return { code: mine?.code ?? null, state }
}
