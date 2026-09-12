'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — client-side referral binding.
//
// The factory keeps TWO registries and pays them different rates out of the
// same 10 % carve:
//
//   `globalReferrers[user]`         bound once per wallet, platform-wide and
//                                   forever, on its first genesis deposit → 2 %
//   `projectReferrers[user][hook]`  bound once per wallet PER PROJECT → 8 %
//
// `factory.deposit` takes ONE referrer argument and offers it to both, each
// accepting only if its own slot is still empty. This module is the browser
// half of that, and it mirrors the shape: one parked value for the lifetime
// slot, one map keyed by hook for the project slots.
//
//   • `?ref=<address>` is captured on ANY page load — see `<ReferralCapture/>`
//     in the root layout — and parked in localStorage, because the deposit
//     that finally spends it may happen hours later on a different project.
//     Capture cannot filter self-referral, because a first-time visitor
//     usually has no wallet connected yet.
//   • On a project page the same `?ref=` is ALSO claimed for that project, by
//     `captureProjectReferrerFromUrl`. That runs from the terminal rather than
//     the layout for one boring reason: the layout knows the path, and the
//     project slots are keyed by hook address, which only the terminal holds.
//   • First link wins, exactly like both on-chain registries — and it wins
//     PER SLOT. A later `?ref=` never overwrites the lifetime value, and never
//     overwrites a project that already has one, but a new project is a fresh
//     slot and the new link takes it.
//   • Self-referral is caught at spend time instead, and the stored value is
//     cleared rather than merely ignored. Clicking your own link is a normal
//     way to check that it works; leaving it parked would let that one click
//     permanently occupy the slot and lock out every real referrer.
//
// ── Which slot gets sent, when they disagree ─────────────────────────────────
//
// `resolveReferrerNow` prefers the PROJECT value and falls back to the
// lifetime one. The factory offers whatever it is handed to both registries,
// so this is a real choice with a loser, and it is worth being explicit about
// why the project value wins.
//
// Take a visitor who clicked A's link on the home page and then arrived at a
// project through B's link, having never deposited before. Send B and B may
// take both slots — up to the whole 10 %. Send A and A takes the lifetime slot
// for 2 %, while the 8 % project leg ORPHANS to the buyback reservoir, because
// A almost certainly holds no deposit in this project and the factory's gate
// will refuse them.
//
// So sending A pays less to everyone and burns the larger leg. A is not being
// robbed of anything: clicking a link creates no on-chain claim, only a
// deposit does, and this visitor had never made one. The deposit is attributed
// to the wallet that actually caused it.
//
// What this module deliberately does NOT check: whether either referrer is
// eligible. The factory also requires `pogQuota[referrer] > 0` for both slots,
// and a deposit in THIS project for the 8 % one. Both rejections are silent
// on-chain — the deposit still succeeds (a stale link must never brick one),
// the binding just does not happen and that leg falls through to the buyback
// reservoir. Checking here would mean extra RPC reads on every page load to
// change nothing about the outcome, so the surface that matters is the SHARE
// side — see `ReferralPanel`, which reads `canBindProjectReferral` so a sharer
// learns their link is not live before they broadcast it.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import { ZERO_ADDRESS } from './contracts'
import { isRefCodeShape } from './refCode'

const STORAGE_KEY = 'tosh_referrer'
const PROJECT_STORAGE_KEY = 'tosh_referrer_by_project'
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

// ─── Project slots ───────────────────────────────────────────────────────────
//
// One JSON object rather than a key per hook, so the whole map can be read,
// rewritten and evicted as a unit. Every value is re-validated on read: this
// is user-writable storage whose contents end up as a payee in a transaction,
// so a hand-edited or half-written entry has to fail closed rather than be
// trusted for having come from us.

type ProjectReferrers = Record<string, Address>

/** Hook addresses are checksummed by viem and lowercased here, so a map
 *  written from one casing is readable from the other. */
function projectKey(hookAddress: Address): string {
  return hookAddress.toLowerCase()
}

function readProjectReferrers(): ProjectReferrers {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const out: ProjectReferrers = {}
    for (const [hook, referrer] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isAddress(hook) || typeof referrer !== 'string' || !isAddress(referrer)) continue
      out[hook.toLowerCase()] = getAddress(referrer)
    }
    return out
  } catch { return {} }
}

function writeProjectReferrers(map: ProjectReferrers): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(map)) }
  catch { /* private mode — the link still works for this session */ }
}

function readProjectReferrer(hookAddress: Address): Address | null {
  return readProjectReferrers()[projectKey(hookAddress)] ?? null
}

function clearProjectReferrer(hookAddress: Address): void {
  const map = readProjectReferrers()
  if (!(projectKey(hookAddress) in map)) return
  delete map[projectKey(hookAddress)]
  writeProjectReferrers(map)
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
 * Park `?ref=` from the current URL into the LIFETIME slot, if this visitor is
 * not already bound.
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
 * Claim `?ref=` from the current URL for ONE project, if that project has no
 * referrer yet.
 *
 * Called from the project terminal, not the root layout, because the slots are
 * keyed by hook address and the layout does not know it. Runs unconditionally
 * on mount: a visitor who arrives on a project link today and deposits next
 * week must still pay the sharer who sent them, so the claim has to survive in
 * storage rather than live in the URL.
 */
export function captureProjectReferrerFromUrl(hookAddress: Address | undefined): void {
  if (!hookAddress) return
  if (readProjectReferrer(hookAddress)) return

  const fromUrl = readReferrerParam()
  if (!fromUrl) return

  const map = readProjectReferrers()
  map[projectKey(hookAddress)] = fromUrl
  writeProjectReferrers(map)
}

/**
 * The referrer to spend RIGHT NOW, read straight from storage.
 *
 * `useBoundReferrer` below only publishes its value from an effect, so the
 * first client frame after mount still reads `ZERO_ADDRESS`. A deposit signed
 * in that frame burns the wallet's one and only lifetime binding on nobody.
 * Callers that are about to send `factory.deposit` resolve the address here
 * instead of trusting the rendered prop.
 *
 * `hookAddress` selects the project slot, which wins over the lifetime one —
 * see the note at the top of this file for why. Omit it and this degrades to
 * the lifetime slot alone.
 */
export function resolveReferrerNow(
  userAddress: Address | undefined,
  hookAddress?: Address,
): Address {
  const isSelf = (addr: Address) =>
    !!userAddress && addr.toLowerCase() === userAddress.toLowerCase()

  if (hookAddress) {
    const forProject = readProjectReferrer(hookAddress)
    if (forProject && isSelf(forProject)) {
      // Evict rather than skip, so one click on your own link does not occupy
      // this project's slot for good. The lifetime slot is still considered
      // below — the two are independent, and only one of them is self-referral.
      clearProjectReferrer(hookAddress)
    } else if (forProject) {
      return forProject
    }
  }

  const stored = readStoredReferrer()
  if (!stored) return ZERO_ADDRESS
  if (isSelf(stored)) {
    clearStoredReferrer()
    return ZERO_ADDRESS
  }
  return stored
}

/**
 * The referrer to display, and the capture side-effect.
 *
 * Returns `ZERO_ADDRESS` when nobody referred this visitor — the factory reads
 * that as "no referral" and sweeps that leg of the commission to the buyback
 * reservoir instead of accruing it to a claimant.
 */
export function useBoundReferrer(
  userAddress: Address | undefined,
  hookAddress?: Address,
): Address {
  const [referrer, setReferrer] = useState<Address>(ZERO_ADDRESS)

  useEffect(() => {
    captureReferrerFromUrl()
    captureProjectReferrerFromUrl(hookAddress)

    // Reuses the spend-time resolver rather than reimplementing the preference
    // order, so what the page displays cannot drift from what a deposit sends.
    const resolved = resolveReferrerNow(userAddress, hookAddress)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReferrer(resolved)
  }, [userAddress, hookAddress])

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
 * ONE CODE PER WALLET, not one per project. The code resolves to an address,
 * and which project a link lands on is carried by `?p=` and decided by where
 * the deposit happens — so per-project attribution needs no per-project code.
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
