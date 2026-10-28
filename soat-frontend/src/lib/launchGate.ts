/**
 * Whether this build takes new launches.
 *
 * Closes the site's way in to `createLaunch` — the `/launch` form and every
 * link to it — and nothing else. The factory itself still accepts a direct
 * call from its owner.
 *
 * ⚠ SPELLED OUT, NOT COMPUTED. Next inlines `NEXT_PUBLIC_*` by substituting the
 *   literal `process.env.NEXT_PUBLIC_LAUNCHES_PAUSED`; see `ENABLED_LOCALES`.
 */
export const LAUNCHES_PAUSED = process.env.NEXT_PUBLIC_LAUNCHES_PAUSED === '1'
