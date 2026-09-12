/**
 * /r/[code] — the short referral link, and the only thing that resolves one.
 * ───────────────────────────────────────────────────────────────────────────
 *  `/r/swift-amber-otter?p=RHRSL`  →  `/projects/0x…?ref=0x…`
 *
 *  Twenty-eight characters of path and query where the old link spent
 *  ninety-nine: `/projects/` plus a 42-character token address plus `?ref=`
 *  plus a 42-character referrer address, pasted into bios and group chats.
 *
 *  ── This route is a translator, not a mechanism ──────────────────────────
 *
 *  It resolves the code to an address and redirects to the SAME
 *  `?ref=<address>` URL the old links used. Nothing downstream changes:
 *  `<ReferralCapture/>` in the root layout still parks `?ref=` in
 *  localStorage, `useBoundReferrer` still applies first-link-wins, and
 *  `resolveReferrerNow` still clears self-referral at spend time. The short
 *  form is a nicer way to write an existing link, and deliberately not a
 *  second referral path with its own rules to keep in sync.
 *
 *  ── An unresolvable code still lands the visitor ─────────────────────────
 *
 *  Every failure here — a truncated paste, an unknown code, a registry that
 *  will not answer — redirects to the directory WITHOUT `?ref=` rather than
 *  showing a 404. Two reasons, and the second is the real one:
 *
 *    1. A 404 on a forwarded marketing link loses the visitor, which is worse
 *       for everyone in the transaction including the referrer.
 *    2. Dropping the referrer costs nothing permanent. No binding exists until
 *       the visitor's first genesis deposit, so a link that failed to resolve
 *       at 10:00 works when clicked again at 10:05 — the slot is still open.
 *
 *  What it must never do is resolve to the WRONG address; that IS permanent.
 *  Hence exact matches only, and a row whose address fails validation is
 *  treated as no row. See `src/app/api/ref/route.ts` for the same asymmetry.
 */

import { redirect } from 'next/navigation'

import { isAddress, getAddress } from 'viem'

import { supabase, REGISTRY_READ_DEADLINE_MS } from '@/app/lib/supabase'
import { isRefCodeShape } from '@/lib/refCode'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { reportError } from '@/lib/observability'

type Props = {
  params: Promise<{ code: string }>
  searchParams: Promise<{ p?: string | string[] }>
}

/** A ticker is 2–12 characters of letters and digits; anything else is junk
 *  and is not worth a query. Upper-cased for the comparison, because that is
 *  how symbols are written on chain and stored in the registry. */
const SYMBOL_RE = /^[A-Z0-9]{2,12}$/

/**
 * Resolve a code to a referrer, or null.
 *
 * Never throws: the caller redirects either way, and the difference between
 * "no such code" and "Supabase is down" changes nothing it can do about it.
 * The distinction is still worth recording, so the unreachable case reports.
 */
async function resolveReferrer(code: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('referral_codes')
      .select('address')
      .eq('code', code)
      // Bounded because this blocks a redirect, and the redirect is the whole
      // page. Without it an unreachable registry holds a clicked link for
      // ~14 s (no default timeout, four retries with backoff) before landing
      // the visitor anyway — so the wait buys nothing. See `checkSupabase.mjs`.
      .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))
      .maybeSingle()

    if (error) {
      reportError(error, { surface: 'ssr', extra: { route: '/r/[code]', stage: 'resolve' } })
      return null
    }

    const address = (data as { address: string } | null)?.address
    if (!address) return null

    // Re-validated here even though the column has a CHECK constraint. This
    // value becomes a payee on a deposit, and being wrong about it is not
    // recoverable, so it is verified where it is used rather than trusted for
    // where it came from.
    if (!isAddress(address)) {
      reportError(new Error('referral_codes row failed address validation'), {
        surface: 'ssr',
        extra: { route: '/r/[code]', code },
      })
      return null
    }

    return getAddress(address)
  } catch (err) {
    reportError(err, { surface: 'ssr', extra: { route: '/r/[code]', stage: 'resolve' } })
    return null
  }
}

/**
 * Resolve `?p=<symbol>` to a token address, or null to land on the directory.
 *
 * OLDEST MATCH WINS, and that is a decision rather than an arbitrary
 * `limit(1)`. Symbols are not unique on chain — nothing stops a second launch
 * calling itself RHRSL — so this query can legitimately match several rows.
 * Ordering by `created_at` ascending means a given `?p=` points at the same
 * project forever: a newer launch cannot take over a symbol that links already
 * in circulation depend on. Picking the newest would have let anyone hijack
 * the destination of every existing link by launching a token with the right
 * ticker.
 *
 * Getting this wrong costs the visitor a landing page, not a referral — `ref`
 * is resolved separately and is already decided by the time this is called.
 */
async function resolveProject(symbol: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('token_address')
      .eq('chain_id', TARGET_CHAIN_ID)
      .eq('symbol', symbol)
      .not('token_address', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))
      .maybeSingle()

    if (error || !data) return null

    const token = (data as { token_address: string | null }).token_address
    if (!token || !isAddress(token)) return null
    return getAddress(token)
  } catch {
    // Deliberately silent. A missing landing page is a cosmetic miss on a
    // marketing link, and the directory is a fine place to arrive.
    return null
  }
}

export default async function ReferralLandingPage({ params, searchParams }: Props) {
  const [{ code: rawCode }, query] = await Promise.all([params, searchParams])

  const code = rawCode.trim().toLowerCase()

  // Shape-only, and shape-only in the database too. The word lists are not
  // checked, so extending them never invalidates a code that is already
  // printed on something. See `src/lib/refCode.ts`.
  const referrer = isRefCodeShape(code) ? await resolveReferrer(code) : null

  const rawSymbol = Array.isArray(query.p) ? query.p[0] : query.p
  const symbol = (rawSymbol ?? '').trim().toUpperCase()
  const token = SYMBOL_RE.test(symbol) ? await resolveProject(symbol) : null

  const destination = new URL(
    token ? `/projects/${token}` : '/projects',
    // Discarded — `redirect` is given only the path and query below. A base is
    // required to construct a URL from a relative path, and inventing one here
    // is safer than reading the request host, which is attacker-controlled and
    // has no business influencing where this redirect points.
    'https://tosh.invalid',
  )
  if (referrer) destination.searchParams.set('ref', referrer)

  // Relative, so the redirect stays on whatever origin served the link.
  redirect(`${destination.pathname}${destination.search}`)
}
