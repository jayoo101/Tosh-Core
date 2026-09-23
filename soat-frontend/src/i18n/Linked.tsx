import Link from 'next/link'

/**
 * One run inside a sentence that is a link, with the sentence still whole.
 *
 * ── Why this is `Emph`'s problem again ──────────────────────────────────────
 *
 * Read `Emphasis.tsx` first; the argument is the same one and it is made in full
 * there. The short version: leaving the anchor in the JSX splits the sentence
 * into three fragments at English word order, and
 *
 *     'Claim it from the referral desk further down this page, or from'
 *     'your referral ledger'
 *     'for every project at once. Nothing expires.'
 *
 * has no correct Chinese translation, because Chinese does not put the
 * prepositional phrase there and a translator cannot move a fragment they were
 * handed separately. So the sentence stays intact and marks its own anchor:
 *
 *     'Claim it … or from [your referral ledger] for every project at once.'
 *
 * and each locale puts the brackets where its own grammar wants them.
 *
 * ── Why brackets, when emphasis uses stars ──────────────────────────────────
 *
 * Because the two can appear in the same sentence and a shared marker would make
 * the nesting ambiguous. They are also different kinds of instruction: `*` is
 * presentational and dropping it costs a highlight, whereas `[` carries the only
 * route to another page in the sentence. Different stakes, different marker.
 *
 * ⚠ NO BRACKETS MEANS NO LINK, NOT A CRASH. An unmarked string renders as plain
 *   text — the sentence still reads, the reader still learns the commission is
 *   claimable, and they lose a shortcut to a page the navigation reaches anyway.
 *   That is the right failure on a page about money: `guard:i18n` fails the build
 *   on a locale that drops or unbalances the pair, which is where a translation
 *   bug should surface. Throwing here would trade a missing hyperlink for a blank
 *   dialog over a confirmed deposit.
 *
 * ⚠ ONLY THE FIRST PAIR IS A LINK. A second `[…]` in the same string renders as
 *   literal brackets rather than a second anchor, because `href` is one value and
 *   silently pointing two different phrases at the same place is worse than
 *   showing the translator their string did not do what they expected.
 */
export function Linked({
  text, href, onClick, className,
}: {
  text:       string
  href:       string
  onClick?:   () => void
  className?: string
}) {
  const open = text.indexOf('[')
  const close = text.indexOf(']', open + 1)
  if (open === -1 || close === -1) return <>{text}</>

  return (
    <>
      {text.slice(0, open)}
      <Link href={href} onClick={onClick} className={className}>
        {text.slice(open + 1, close)}
      </Link>
      {text.slice(close + 1)}
    </>
  )
}
