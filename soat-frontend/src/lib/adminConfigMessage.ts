/**
 * The exact bytes an owner signs to rotate the PoG band.
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
 * The alignment inside the value fields is significant: the values line up
 * under each other, which is cosmetic to a human and load-bearing to a
 * signature. That is the reason this lives in a named constant rather than
 * being spread across template literals.
 *
 * WHY THE TWO WEI DIALS ARE IN HERE AND NOT JUST IN THE BODY
 *
 * `floorWei` and `maxAllocWei` became rotatable alongside the rate. A field the
 * server acts on but the owner did not sign is a field anybody who can replay
 * or intercept the request gets to choose — and of the three, the ceiling is
 * the one worth attacking: it is the per-wallet deposit cap. So all three are
 * inside the signed bytes, and a request that carries a dial the message does
 * not is rejected as unauthorised rather than partially applied.
 */
export const ADMIN_CONFIG_MESSAGE_TEMPLATE =
  'Tosh Admin Config Update\n' +
  'rate:        {rate}\n' +
  'floorWei:    {floorWei}\n' +
  'maxAllocWei: {maxAllocWei}\n' +
  'nonce:       {nonce}\n' +
  'expiresAt:   {expiresAt}'

/**
 * The literal that stands in for "leave this dial where it is".
 *
 * A rotation that only moves the rate must still sign a complete message, or
 * the server would have to guess which of several possible texts was signed.
 * An explicit sentinel makes the intent part of the signature: `keep` is a
 * statement about the other two dials, not the absence of one.
 */
export const ADMIN_CONFIG_KEEP = 'keep'

export interface AdminConfigUpdate {
  rate: number
  /** Wei, as a decimal string, or null to leave the dial alone. */
  floorWei?: string | bigint | null
  /** Wei, as a decimal string, or null to leave the dial alone. */
  maxAllocWei?: string | bigint | null
  nonce: bigint | string | number
  expiresAt: number
}

/**
 * Build the canonical message.
 *
 * `rate` is interpolated with JavaScript's own number-to-string conversion,
 * which is what both the browser and the server already did — so `0.5` signs as
 * `0.5` and not `0.500000`. The wei dials are interpolated as decimal integer
 * strings, never as `Number`, because a wei figure does not survive a double.
 * The server rebuilds this from the values it parsed out of the request body,
 * so any reformatting on either side invalidates the signature rather than
 * being quietly tolerated.
 */
export function buildAdminConfigMessage(u: AdminConfigUpdate): string {
  return ADMIN_CONFIG_MESSAGE_TEMPLATE
    .replace('{rate}', String(u.rate))
    .replace('{floorWei}', weiField(u.floorWei))
    .replace('{maxAllocWei}', weiField(u.maxAllocWei))
    .replace('{nonce}', u.nonce.toString())
    .replace('{expiresAt}', String(u.expiresAt))
}

function weiField(v: string | bigint | null | undefined): string {
  return v === null || v === undefined ? ADMIN_CONFIG_KEEP : v.toString()
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
