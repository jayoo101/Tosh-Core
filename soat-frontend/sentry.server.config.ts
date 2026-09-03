/**
 * Node runtime Sentry init (pre-mainnet item #26).
 *
 * Server DSN is read from `SENTRY_DSN` first so the server can be pointed at a
 * different project than the browser; it falls back to the public one when
 * only a single project exists.
 */

import * as Sentry from '@sentry/nextjs'

import { SENTRY_ENVIRONMENT } from '@/lib/observability'

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN ?? ''

if (dsn) {
  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: 0,
    // The PoG signing route handles a private key and wallet addresses.
    // Never let request bodies or headers ride along with an event.
    sendDefaultPii: false,
  })
}
