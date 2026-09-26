/**
 * Whether this build takes new launches.
 *
 * Closes the site's way in to `createLaunch` — the `/launch` form and every
 * link to it — and nothing else. The factory itself still accepts a direct
 * call; pausing it on chain would also stop `registerPoG`, and with it every
 * new wallet's way into a raise that is already running.
 *
 * Closed while launches move to a replacement factory: the current hook has no
 * way to collect the trading fees its genesis position earns, so every pool it
 * opens strands them.
 *
 * ⚠ SPELLED OUT, NOT COMPUTED. Next inlines `NEXT_PUBLIC_*` by substituting the
 *   literal `process.env.NEXT_PUBLIC_LAUNCHES_PAUSED`; see `ENABLED_LOCALES`.
 */
export const LAUNCHES_PAUSED = process.env.NEXT_PUBLIC_LAUNCHES_PAUSED === '1'
