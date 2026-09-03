/**
 * observability.ts — the one seam every error report goes through.
 * ───────────────────────────────────────────────────────────────────────────
 *  Pre-mainnet item #26 — PM-E1 in `docs/PRE_MAINNET_CHECKLIST.md`.  Until this
 *  existed, `app/error.tsx` logged to the browser console in dev and dropped
 *  the error entirely in production: a user hit a broken page and nobody found
 *  out.
 *
 *  This file is only the FRONTEND half of #26.  The on-chain half — Defender /
 *  Tenderly alerts on the factory's `Paused` / `OwnershipTransferred` /
 *  `PogSignerUpdated` events — is PM-E2 and is still open.  Do not read a
 *  working Sentry install as "monitoring is done".
 *
 *  Design notes
 *  ────────────
 *  • DSN absent → every function here is a no-op.  That is the normal state
 *    for local dev and for the Sepolia staging deploy; monitoring is opt-in
 *    per environment, not something a missing env var can half-enable.
 *  • Callers never import `@sentry/nextjs` directly.  Swapping the backend
 *    (or adding a second sink alongside it) is a change to this file only,
 *    and `grep reportError` stays the complete list of report sites.
 *  • `reportError` never throws and never rejects.  It is called from error
 *    boundaries — a monitoring failure must not become the thing that breaks
 *    the fallback UI.
 *
 *  NOT covered here: on-chain alerting.  Paused / OwnershipTransferred /
 *  PogSignerUpdated on the factory are watched by Defender or Tenderly, which
 *  is dashboard configuration rather than application code.  See
 *  `docs/INCIDENT_RESPONSE.md` for the alert list and routing.
 */

import * as Sentry from '@sentry/nextjs'

/** Reported alongside every event so staging noise never pages the on-call. */
export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT
  ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')

/**
 * The browser DSN. Public by design — a DSN is a write-only ingest key, not a
 * credential, which is why it is safe in a `NEXT_PUBLIC_` var.
 */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? ''

/** False in dev and on staging unless a DSN was deliberately provided. */
export function isMonitoringEnabled(): boolean {
  return SENTRY_DSN.length > 0
}

/** Where an error was caught, so the alert says something without a stack. */
export type ErrorSurface =
  | 'root-error-boundary'
  | 'global-error-boundary'
  | 'project-error-boundary'
  | 'tx-lifecycle'
  | 'api-route'

export interface ReportContext {
  surface: ErrorSurface
  /** Next.js stamps server errors with a digest; it is the only join key
   *  between a user's screenshot and the server-side event. */
  digest?: string
  /** Anything cheap and non-identifying: chain id, route, contract address. */
  extra?: Record<string, unknown>
}

export function reportError(error: unknown, context: ReportContext): void {
  if (!isMonitoringEnabled()) return
  try {
    Sentry.withScope((scope) => {
      scope.setTag('surface', context.surface)
      if (context.digest) scope.setTag('digest', context.digest)
      if (context.extra) scope.setContext('tosh', context.extra)
      Sentry.captureException(error)
    })
  } catch {
    // A broken sink must never take down the boundary that called us.
  }
}
