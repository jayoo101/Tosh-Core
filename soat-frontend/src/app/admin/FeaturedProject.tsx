'use client'

/**
 * The homepage feature pin.
 *
 * `AgentDirectoryHome` ranks "Active markets" by amount raised and draws the
 * first card double-width. This panel overrides that for a bounded window by
 * writing `projects.featured_until` through `POST /api/admin/featured`.
 *
 * ── Why this panel does not use the ambient gate ──────────────────────────
 *
 * Every other control on this page goes through `useActionGate`, which inherits
 * the page's ambient verdict: "is the connected wallet `factory.owner()`". That
 * is the right question for all of them, because all of them are `onlyOwner`
 * writes that would revert from anyone else.
 *
 * It is the wrong question here, and answering it would make this panel
 * unusable. The owner is a 2-of-3 Safe, and `providers.tsx` registers only
 * `injected()` — so the ambient verdict on this page is permanently
 * `[read_only]` for any wallet a browser can actually connect. Deciding which
 * of three eligible cards is drawn widest is not an owner power and does not
 * need the Safe's pen; it needs a credential scoped to exactly that. So the
 * button is a plain button, the authorisation is `CONTENT_ADMIN_SECRET`, and
 * the wallet in the header is irrelevant to it.
 */

import { useCallback, useMemo, useState } from 'react'

import {
  toshToast, shortErrorMessage, useNowMs, useIsHydrated, CLOCK_UNSYNCED,
} from '@/components/ui'
import { useDirectoryProjects, fmtQuote } from '@/components/directory/useDirectoryProjects'
import { Section, ScopeNote, Field, labelCls, fmtDuration } from './shared'

/**
 * Where the operator's credential is kept between clicks.
 *
 * `sessionStorage`, not `localStorage`: the token has to reach the browser to be
 * sent, and there is no version of that which is as good as never sending it —
 * so the mitigation is that it does not outlive the tab. An operator who closes
 * the console has stopped holding it, which is the property a persistent copy
 * would quietly remove for the sake of not retyping.
 */
const CREDENTIAL_KEY = 'tosh.contentAdminSecret'

/** Empty string on a browser with storage disabled, which is the untyped state. */
function readHeldCredential(): string {
  try {
    return sessionStorage.getItem(CREDENTIAL_KEY) ?? ''
  } catch {
    return ''
  }
}

/** The offered windows. The route's own ceiling is 14 days; see `MAX_PIN_HOURS`. */
const DURATIONS = [
  { hours: 6,   label: '6H'  },
  { hours: 24,  label: '24H' },
  { hours: 72,  label: '72H' },
  { hours: 168, label: '7D'  },
] as const

/** Matches the teaser's own expiry cadence, so the two read the same. */
const CADENCE_MS = 10_000

const inputCls =
  `bg-surface-card/50 border border-border-subtle focus:border-brand rounded-lg px-3 py-2.5
   font-mono text-sm text-text-primary disabled:opacity-40 transition-colors duration-150`

export function FeaturedProjectPanel() {
  const { projects, loading } = useDirectoryProjects()
  const nowMs = useNowMs(CADENCE_MS)

  const [selected, setSelected] = useState('')
  const [hours, setHours] = useState<number>(24)
  const [busy, setBusy] = useState(false)

  /**
   * The credential, from storage until the operator types.
   *
   * `typed === null` means "they have not touched the field", which is the only
   * state in which storage is consulted. Deriving it during render rather than
   * seeding state in an effect is not a style preference: an effect that calls
   * `setSecret` is `react-hooks/set-state-in-effect`, which this repository
   * treats as an error, and `useIsHydrated` exists precisely so the
   * "read the browser only after hydration" case does not need one. Before
   * hydration the value is `''`, matching what the server rendered.
   */
  const hydrated = useIsHydrated()
  const [typed, setTyped] = useState<string | null>(null)
  const secret = typed ?? (hydrated ? readHeldCredential() : '')

  const rememberSecret = useCallback((v: string) => {
    setTyped(v)
    try {
      if (v) sessionStorage.setItem(CREDENTIAL_KEY, v)
      else sessionStorage.removeItem(CREDENTIAL_KEY)
    } catch { /* nothing to do; the value still works for this page load */ }
  }, [])

  /**
   * Only what the teaser would actually show.
   *
   * The same filter `AgentDirectoryHome` applies, deliberately duplicated as a
   * filter on a list rather than shared as a predicate, because the two are
   * answering different questions: that one decides what a visitor sees, this
   * one decides what an operator may choose. What they must not do is disagree
   * about eligibility — so a launch that cannot appear in the block is not
   * offered here, which is the whole reason this is a picker and not an address
   * field. Pinning a refundable raise would write a row, report success, and
   * change nothing on the page.
   */
  const eligible = useMemo(
    () => projects.filter(p => p.tab === 'live' || p.tab === 'completed'),
    [projects],
  )

  const pinned = useMemo(() => {
    const live = (p: typeof projects[number]) =>
      p.featuredUntilMs !== null &&
      (nowMs === CLOCK_UNSYNCED || p.featuredUntilMs > nowMs)
    return projects.find(live) ?? null
  }, [projects, nowMs])

  /** What the double-width card holds right now, by the rule the page applies. */
  const currentFeature = useMemo(() => {
    if (pinned && eligible.some(p => p.token === pinned.token)) return pinned
    return [...eligible].sort((a, b) =>
      a.totalNative === b.totalNative ? 0 : a.totalNative > b.totalNative ? -1 : 1,
    )[0] ?? null
  }, [eligible, pinned])

  /**
   * A pin on a launch the teaser will not show.
   *
   * Reachable without anyone doing anything wrong: pin a raise while its window
   * is open, and when the window closes the launch becomes `launching` or
   * `archived` and leaves the eligible set with the pin still on it. Silent
   * otherwise — the operator set a pin, the homepage ignores it, and nothing
   * anywhere says why.
   */
  const pinnedButHidden = pinned !== null && !eligible.some(p => p.token === pinned.token)

  const submit = useCallback(async (hoursToSet: number) => {
    const token = hoursToSet === 0 ? pinned?.token ?? selected : selected
    if (!token || !secret) return

    setBusy(true)
    try {
      const res = await fetch('/api/admin/featured', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ tokenAddress: token, hours: hoursToSet }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      toshToast.success(
        hoursToSet === 0
          ? 'Pin cleared — the homepage is back on its computed order.'
          : `${data.symbol} pinned for ${hoursToSet}h.`,
      )
    } catch (err) {
      toshToast.error(shortErrorMessage(err) ?? 'Could not update the feature pin.')
    } finally {
      setBusy(false)
    }
  }, [pinned, selected, secret])

  const armed = selected !== '' && secret !== '' && !busy

  return (
    <Section
      id="G6-A"
      title="HOMEPAGE FEATURE"
      subtitle="POST /api/admin/featured · off-chain, no transaction · expires on its own"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-note @sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Pinned</dt>
          <dd>
            {loading && projects.length === 0
              ? 'reading…'
              : pinned
                ? `$${pinned.symbol}`
                : 'nothing — computed order'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Expires in</dt>
          <dd>
            {pinned && pinned.featuredUntilMs !== null && nowMs !== CLOCK_UNSYNCED
              ? fmtDuration(
                  BigInt(Math.max(0, Math.floor((pinned.featuredUntilMs - nowMs) / 1000))),
                  'now',
                )
              : '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Big card now</dt>
          <dd>{currentFeature ? `$${currentFeature.symbol}` : 'nothing eligible'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-tertiary">Eligible</dt>
          <dd>{eligible.length} launch{eligible.length === 1 ? '' : 'es'}</dd>
        </div>
      </dl>

      {pinnedButHidden && (
        <ScopeNote tone="warn">
          ${pinned?.symbol} is pinned but is no longer one of the launches this block
          shows, so the pin is doing nothing. Its raise has closed without launching, or
          it is refundable. Clearing the pin costs nothing and removes the confusion.
        </ScopeNote>
      )}

      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>LAUNCH TO FEATURE</span>
        <select
          value={selected}
          disabled={busy || eligible.length === 0}
          onChange={e => setSelected(e.target.value)}
          className={inputCls}
        >
          <option value="">
            {eligible.length === 0 ? 'nothing eligible to feature' : 'select a launch…'}
          </option>
          {eligible.map(p => (
            <option key={p.token} value={p.token}>
              ${p.symbol} · {p.name} · {fmtQuote(p.totalNative)} raised
              {p.tab === 'completed' ? ' · trading' : ' · funding'}
            </option>
          ))}
        </select>
        {/* Only launches whose creator published metadata have a registry row,
            and the route refuses to pin a launch without one. Saying so here is
            cheaper than a 404 the operator has to interpret. */}
        <span className="text-label text-text-tertiary tracking-wider">
          Launches appear once their creator has published metadata.
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>FOR HOW LONG</span>
        <div className="flex flex-wrap gap-2">
          {DURATIONS.map(d => (
            <button
              key={d.hours}
              type="button"
              disabled={busy}
              onClick={() => setHours(d.hours)}
              className={`rounded-lg border px-3 py-2 font-mono text-note transition-colors
                          disabled:opacity-40 ${
                            hours === d.hours
                              ? 'border-brand text-brand'
                              : 'border-border-subtle text-text-tertiary hover:border-brand/50'
                          }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <Field
        label="CONTENT ADMIN CREDENTIAL"
        type="password"
        value={secret}
        onChange={rememberSecret}
        placeholder="CONTENT_ADMIN_SECRET"
        disabled={busy}
        hint="Held for this tab only, never stored. Not the factory owner's key — this credential cannot reach a contract."
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!armed}
          onClick={() => void submit(hours)}
          className="tosh-gradient-bg inline-flex min-h-11 items-center rounded-input px-5 py-3
                     text-readout font-semibold text-bg-base transition-opacity
                     hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Working…' : `Pin for ${hours}h`}
        </button>
        <button
          type="button"
          disabled={busy || !secret || pinned === null}
          onClick={() => void submit(0)}
          className="inline-flex min-h-11 items-center rounded-input border border-border-subtle
                     bg-surface-card px-5 py-3 text-readout font-semibold text-text-primary
                     transition-colors hover:border-brand/50 disabled:opacity-40
                     disabled:cursor-not-allowed"
        >
          Clear pin
        </button>
      </div>

      <ScopeNote>
        This decides ORDER, not eligibility. A pinned launch still has to be one the
        block would show — funding or trading — so pinning cannot put a refundable raise
        on the homepage. Setting a pin clears any other, and every pin lapses on its own,
        so a promotion nobody remembers returns the page to ranking by amount raised
        rather than staying in the largest card indefinitely.
      </ScopeNote>
    </Section>
  )
}
