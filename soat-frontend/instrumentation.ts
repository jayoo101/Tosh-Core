/**
 * Server + edge Sentry init, and the App Router's server-error hook.
 *
 * Pre-mainnet item #26. `onRequestError` is what makes a throw inside
 * `src/app/api/**` — the PoG signing route above all — visible to the
 * on-call instead of dying in a serverless log nobody tails.
 */

import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
