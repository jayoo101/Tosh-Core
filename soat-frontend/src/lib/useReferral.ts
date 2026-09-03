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

/** The shareable link that binds a new wallet to `userAddress`. */
export function buildReferralLink(userAddress: Address): string {
  if (typeof window === 'undefined') return ''
  const url = new URL(window.location.href)
  url.searchParams.set(QUERY_PARAM, userAddress)
  url.hash = ''
  return url.toString()
}
