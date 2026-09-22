/**
 * Bearer-credential checking for the admin routes.
 *
 * Lifted out of `api/admin/config/route.ts`, which is where both of these were
 * written and where the reasoning below was learned. It moved rather than being
 * copied because `api/admin/featured/route.ts` needs the same check, and a
 * second copy of `looksLikeARealSecret` is a second place for the weak-secret
 * refusal to be quietly dropped by someone who did not know it was load
 * bearing. It is load bearing — see below.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Reject values that are not secrets.
 *
 * This guard exists because the deployed `.env.local` had `ADMIN_SECRET` set to
 * the owner's own EVM address. An address is not a secret — it is the first
 * thing an explorer shows for the factory, and `factory.owner()` is a public
 * read — so the bearer fallback was accepting a credential that anybody could
 * derive in one RPC call, silently bypassing the signature path that the rest
 * of that route exists to enforce.
 *
 * A misconfiguration that turns authentication off must fail loudly rather than
 * degrade quietly, so callers refuse the token AND log, instead of shrugging.
 */
export function looksLikeARealSecret(value: string): boolean {
  if (value.length < 32) return false
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return false      // an EVM address
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return false      // a private key / hash
  return true
}

/**
 * Timing-safe bearer-token comparison.
 *
 * `label` names the caller and the variable in the refusal log, because the one
 * thing an operator needs from that line is which of several credentials they
 * have just set to something unusable. It is not read for any other purpose.
 */
export function bearerMatches(
  headerValue: string | null,
  expected: string,
  label: { route: string; varName: string },
): boolean {
  if (!expected) return false
  if (!headerValue) return false

  if (!looksLikeARealSecret(expected)) {
    console.error(
      `[${label.route}] ${label.varName} is set to a value that is not a secret ` +
      '(an address, a key-shaped hex string, or under 32 chars). The bearer ' +
      'path is DISABLED. Use a random 32+ char token or unset the variable.'
    )
    return false
  }

  const m = headerValue.match(/^Bearer\s+(.+)$/i)
  if (!m) return false

  const got = Buffer.from(m[1].trim(), 'utf8')
  const want = Buffer.from(expected, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // expected length, so compare a fixed-width digest of each side instead.
  return timingSafeEqual(
    createHash('sha256').update(got).digest(),
    createHash('sha256').update(want).digest(),
  )
}
