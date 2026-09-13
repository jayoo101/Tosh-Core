/**
 * The exact bytes an owner signs to rotate the PoG exchange rate.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * There were three copies of this template: `buildSignableMessage` in
 * `api/admin/config/route.ts`, `buildAdminConfigMessage` in
 * `app/admin/Monitors.tsx`, and `signable()` in the route's test — each carrying
 * a comment saying it was kept in sync with the others by hand. Two of those
 * comments were load-bearing admissions: the route's said "any change here is a
 * breaking protocol change for the admin UI", and the test's said a divergence
 * "should fail loudly". Neither was true. Nothing compared them, so a change to
 * one produced a signature the other could not verify, and the symptom is a 403
 * that looks exactly like the wrong wallet being connected.
 *
 * A signed message format is the worst possible thing to keep in three places:
 * both sides must agree byte for byte, whitespace included, and the failure is
 * silent on the signing side and indistinguishable from an authorisation error
 * on the checking side.
 *
 * Dependency-free on purpose, like `lib/projectRow.ts`. The route imports it on
 * the server, the admin panel imports it in the browser, and
 * `scripts/rotateGasRate.mjs` parses `TEMPLATE` out of this file rather than
 * holding a fourth copy — see that script's header.
 */

/**
 * The template, in one string, so a reader (and the CLI script's parser) can see
 * the whole format at once instead of reassembling it from concatenation.
 *
 * The alignment inside the value fields is significant: `rate:` is followed by
 * six spaces and `nonce:` by five, so the three values line up. That is
 * cosmetic to a human and load-bearing to a signature, which is the reason this
 * lives in a named constant rather than being spread across template literals.
 */
export const ADMIN_CONFIG_MESSAGE_TEMPLATE =
  'Tosh Admin Config Update\n' +
  'rate:      {rate}\n' +
  'nonce:     {nonce}\n' +
  'expiresAt: {expiresAt}'

/**
 * Build the canonical message.
 *
 * `rate` is interpolated with JavaScript's own number-to-string conversion,
 * which is what both the browser and the server already did — so `0.1` signs as
 * `0.1` and not `0.100000`. The server rebuilds this from the numbers it parsed
 * out of the request body, so any reformatting on either side invalidates the
 * signature rather than being quietly tolerated.
 */
export function buildAdminConfigMessage(
  rate: number,
  nonce: bigint | string | number,
  expiresAt: number,
): string {
  return ADMIN_CONFIG_MESSAGE_TEMPLATE
    .replace('{rate}', String(rate))
    .replace('{nonce}', nonce.toString())
    .replace('{expiresAt}', String(expiresAt))
}

/**
 * How long a freshly-signed instruction stays usable, by owner shape.
 *
 * These are not two guesses at the same number. An EOA owner signs in one
 * gesture in one wallet, so minutes is generous and a tight window is free. A
 * contract owner — the 2-of-3 Safe this protocol actually uses — cannot: the
 * signature is a concatenation of confirmations from two different people on
 * two different devices, and the elapsed time between the first and the second
 * is however long it takes to reach a human. The old five-minute cap therefore
 * did not merely inconvenience the Safe path, it made it unsatisfiable: the
 * instruction expired long before the second owner opened their phone.
 *
 * Widening this is only safe because replay is prevented by the monotonic nonce
 * rather than by the expiry, and that nonce is now persisted in the shared store
 * (`app/lib/adminNonce.ts`). While it was a per-process `let`, any instance
 * restart reset it to zero and the expiry was the ONLY thing standing between a
 * captured payload and a rate downgrade — so a long window then would have been
 * a real exposure, and is not one now. Do not raise these without checking that
 * the nonce is still shared.
 */
export const SIGNATURE_WINDOW_SEC = {
  eoa: 5 * 60,
  contract: 24 * 60 * 60,
} as const
