import { NotFoundBody } from '@/components/NotFoundBody'

/*
 * not-found.tsx — 404 page for unmatched routes
 * ───────────────────────────────────────────────────────────────────────────
 *  Replaces Next.js's default un-styled 404 with a cryptographic-console
 *  variant so a wrong URL still feels like part of the protocol UI rather
 *  than a framework default.
 *
 *  The route stays a server file for its metadata; the body is a client
 *  component because the copy comes from the dictionary.
 */

export const metadata = {
  // Brand token matches layout.tsx and the navbar wordmark. The `//` route
  // marker stays: this title has a job the root one does not, which is saying
  // which page failed.
  title: 'ToshX // 404 // NO_SUCH_ROUTE',
}

export default function NotFound() {
  return <NotFoundBody />
}
