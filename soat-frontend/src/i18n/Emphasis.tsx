/**
 * One phrase inside a sentence, brighter than the rest.
 *
 * ── Why the dictionary owns the position ────────────────────────────────────
 *
 * Because it is the only place that can. The emphasis in
 *
 *     The floor is measured against gas this address has <span>already spent</span>
 *
 * lands on the verb, and the verb is at the end of the clause in English and in
 * front of the noun in Chinese. Leaving the `<span>` in the JSX pins it to an
 * English word order and there is no correct translation of the three fragments
 * it creates — a translator handed "The floor is measured against gas this
 * address has", "already spent" and ", across {chains}, so it only moves as that
 * history grows." separately cannot produce a Chinese sentence out of them.
 *
 * So the sentence stays whole and carries its own emphasis:
 *
 *     'The floor is measured against gas this address has *already spent*, …'
 *
 * and every locale puts the stars where its own grammar wants them. The
 * alternative was dropping the highlight, which reads the same to a snapshot and
 * worse to a person: that phrase is the one word in the paragraph that answers
 * "so what do I do", and the paragraph exists because the previous version of
 * this screen sent people off to wait for something that was never coming.
 *
 * ⚠ ODD STARS ARE A TRANSLATION BUG, not a render-time one. An unpaired `*`
 *   leaves its tail unemphasised rather than throwing, because a missing
 *   highlight is a cosmetic loss and a blank panel on a page about money is not.
 *   `guard:i18n` fails the build on unbalanced stars, which is where that belongs
 *   — before it ships, not after.
 */
export function Emph({ text }: { text: string }) {
  return (
    <>
      {text.split('*').map((run, i) =>
        i % 2 === 1
          ? <span key={i} className="text-text-primary">{run}</span>
          : run,
      )}
    </>
  )
}
