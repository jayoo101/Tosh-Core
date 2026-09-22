/**
 * When the `unattested` gate should read gas history without being asked.
 *
 * This is four lines of `&&` in a `useEffect`, extracted because of what it costs
 * to get wrong rather than because of what it costs to read. An auto-started scan
 * is 5-25 upstream calls against a credit budget, and the last version of this
 * rule lived in `usePogFlow` keyed on "a wallet connected" — which, with
 * `PogLookupProvider` mounted in `app/providers.tsx`, meant every page and every
 * visitor. It exhausted the budget in production and took the raise funnel with
 * it. The rule is now narrow, and narrow rules are worth pinning.
 *
 * Exported as a predicate so the two properties that matter can be tested without
 * a render harness: it fires once per wallet, and it does not fire again on the
 * way back to `idle` after a failure.
 */
export function shouldAutoScan(args: {
  /** Quota has been read, is zero, and is what blocks the deposit. */
  readonly unattested: boolean
  /** The connected wallet, or `undefined` before one is. */
  readonly wallet: string | undefined
  /** Where the lookup currently stands. */
  readonly phase: 'idle' | 'scanning' | 'ready' | 'failed'
  /** Lowercased wallet this already fired for, from a ref. */
  readonly startedFor: string | null
}): boolean {
  const { unattested, wallet, phase, startedFor } = args
  // Nothing to size a quota for, or nothing blocking a deposit.
  if (!unattested || !wallet) return false
  // `idle` is the only phase with no answer and none on the way. `failed` is
  // deliberately excluded: it returns here, and firing on it would turn one dead
  // upstream host into an unbounded retry loop. Retrying is the button's job.
  if (phase !== 'idle') return false
  // Once per wallet. A re-render must not start a second scan, and switching
  // wallets must not be mistaken for one.
  return startedFor !== wallet.toLowerCase()
}
