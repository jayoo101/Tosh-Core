'use client'

import { ProjectLogo } from '@/components/ProjectLogo'

/**
 * The listing, as it will read once the launch confirms.
 *
 * The redesign's one genuinely new element on /launch, and it earns the column
 * it takes: every other panel on that page describes what the creator is
 * agreeing to, and this is the only one that shows what everybody else will
 * see. A name, a ticker and a picture are chosen once here and then read by
 * the whole directory.
 *
 * WHAT THE MOCK'S THIRD ROW ASKED FOR AND THIS DOES NOT OFFER. The prototype
 * labels it "Genesis target" and wires it to an editable field, which this
 * protocol has no room for: the minimum raise is `defaultSoftCap`, a single
 * owner-tunable dial on the factory that every launch is measured against. A
 * per-launch target would be a number the creator could type and the contract
 * would ignore — the same class of fiction as the mock's price column. The row
 * survives, because a creator does need to know what their raise has to clear,
 * and it is labelled as the factory's number rather than theirs.
 *
 * The shell is the reference's, at its measurements: a bordered header strip
 * carrying the eyebrow, then one padded block with the `.tosh-glow` overlay
 * behind the identity, the description and the rows. It reads the same as
 * `HeroFeedPanel`'s frame by construction rather than by copy — both are
 * read-only reports of chain-shaped state sitting beside something else, and
 * two hand-rolled versions of that frame is how the redesign grows a second
 * dialect.
 */
export function LaunchPreview({
  name,
  symbol,
  description,
  logoUrl,
  windowLabel,
  minimumRaise,
  poolAddress,
}: {
  name: string
  symbol: string
  description: string
  logoUrl: string
  /** The immutable genesis window, already short — `3h`, `24h`, `72h`. */
  windowLabel: string
  /** The factory's `defaultSoftCap`, formatted, or an em dash while unread. */
  minimumRaise: string
  /** The mined CREATE2 hook address, empty until a deploy grinds one. */
  poolAddress: string
}) {
  const rows: { label: string; value: string; pending?: boolean }[] = [
    { label: 'Minimum raise', value: minimumRaise },
    { label: 'Window', value: windowLabel },
    {
      label: 'Pool address',
      // Truncated in place rather than by the caller: the full value is 42
      // characters and this column is a third of a sidebar.
      value: poolAddress ? `${poolAddress.slice(0, 6)}…${poolAddress.slice(-4)}` : 'ground at deploy',
      pending: !poolAddress,
    },
  ]

  return (
    <div>
      <div className="overflow-hidden rounded-panel border border-border-subtle bg-surface-card shadow-panel">
        {/* The reference's header strip, kept at its measurements: a bordered
            band with the eyebrow in it, not a `Card` header. The second span is
            an addition — the footnote that used to carry this moved outside the
            panel with the reference's layout, and a mock-up of a token that
            does not exist yet should say so inside its own frame. */}
        <div className="flex items-center justify-between border-b border-border-subtle px-card py-gap">
          <span className="font-mono text-micro uppercase text-text-tertiary">Preview</span>
          <span className="font-mono text-micro text-text-quiet">not yet deployed</span>
        </div>

        {/* `.tosh-glow` at 50%, which is the reference's overlay and its
            opacity. It replaced a hand-rolled `bg-gradient-to-br from-brand/10`
            wash: the glow is the signature this app already owns in
            globals.css, and a second gradient beside it was the redesign
            growing a dialect. Children carry `relative` so they sit above it,
            and it is `pointer-events-none` + `aria-hidden` because it is
            decoration over a readout. */}
        <div className="relative p-card">
          <div className="tosh-glow pointer-events-none absolute inset-0 opacity-50" aria-hidden />

          <div className="relative flex items-center gap-gap">
            <ProjectLogo
              src={logoUrl || null}
              name={name || symbol || '?'}
              className="h-10 w-10"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-title font-bold text-text-primary">
                ${symbol || 'SYMBOL'}
              </span>
              <span className="truncate text-note text-text-tertiary">
                {name || 'Agent name'}
              </span>
            </div>
          </div>

          {/* `line-clamp-3` and a floor under it, both the reference's: the
              panel is sticky beside a form, so a description growing a line per
              keystroke would move the rows under it while they are being read. */}
          <p className="relative mt-gap line-clamp-3 min-h-[3.5rem] text-note leading-relaxed text-text-secondary">
            {description.trim() || (
              <span className="text-text-quiet">
                Your description appears here as you type.
              </span>
            )}
          </p>

          <dl className="relative mt-gap flex flex-col gap-gap-tight border-t border-border-subtle pt-gap">
            {rows.map(r => (
              <div key={r.label} className="flex items-center justify-between gap-4">
                <dt className="font-mono text-micro uppercase text-text-tertiary">{r.label}</dt>
                <dd
                  className={`font-mono text-note tabular-nums ${
                    r.pending ? 'text-text-quiet' : 'text-text-primary'
                  }`}
                >
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <p className="mt-gap px-1 text-micro leading-relaxed text-text-quiet">
        This is how your launch appears in the directory once it confirms.
      </p>
    </div>
  )
}
