/**
 * Browser-side Sentry init (pre-mainnet item #26).
 *
 * Next.js loads this file before any application code on the client. With no
 * DSN configured `Sentry.init` installs nothing and every later capture call
 * is a no-op, which is the intended state for local dev and Sepolia staging.
 */

import * as Sentry from '@sentry/nextjs'

import { SENTRY_DSN, SENTRY_ENVIRONMENT } from '@/lib/observability'

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    // Errors are the point. Performance sampling is off until there is a
    // production traffic baseline worth paying the quota for.
    tracesSampleRate: 0,
    // A launchpad UI shows wallet addresses and balances. Session Replay and
    // PII capture stay off so an incident never turns into a data problem.
    sendDefaultPii: false,
    ignoreErrors: [
      // Wallet rejections are the user saying no, not a fault.
      'User rejected the request',
      'User denied transaction signature',
      // Injected-wallet extensions racing the page unload.
      'ResizeObserver loop completed with undelivered notifications',
    ],
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
