/**
 * Edge runtime Sentry init (pre-mainnet item #26).
 *
 * No route opts into the edge runtime today, but Next.js loads this whenever
 * one does — leaving it out is how an edge route silently stops reporting.
 */

import * as Sentry from '@sentry/nextjs'

import { SENTRY_ENVIRONMENT } from '@/lib/observability'

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN ?? ''

if (dsn) {
  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
}
