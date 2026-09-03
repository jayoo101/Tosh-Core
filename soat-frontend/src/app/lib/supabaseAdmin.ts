import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The writer. Separate module from `supabase.ts` on purpose: that one is the
 * anon client and is safe anywhere, this one holds a key that must never be
 * bundled, and keeping them in one file makes the distinction a matter of
 * which export you happened to import.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` deliberately carries no `NEXT_PUBLIC_` prefix,
 * which is what stops it reaching a browser: Next only inlines `NEXT_PUBLIC_*`
 * into client bundles and substitutes `undefined` for everything else. The
 * `window` check below is not that defence — it is the one that turns a
 * mistaken client-side import into a legible error instead of a Supabase 401
 * from a client built with `undefined`.
 *
 * Why a service role key is needed at all: `supabase/migrations/0001` gives
 * `anon` SELECT and nothing else, because the checks that authorise a write
 * live in `POST /api/projects` — read the launch from chain, recover the
 * signer, require it to equal `launch.creator` — and none of them can be
 * expressed as a row predicate. RLS cannot re-derive them, so the route has to
 * be the only writer, so the route needs a role that RLS does not stop.
 */

let cached: SupabaseClient | null = null

export class SupabaseAdminUnavailable extends Error {
  constructor(missing: string) {
    super(
      `${missing} is not set, so project metadata cannot be written. ` +
      'Set it from the Supabase dashboard under Project Settings → API → ' +
      'service_role. It is a server-side secret: it bypasses row-level ' +
      'security, so it belongs in the hosting provider secret store and must ' +
      'never be given a NEXT_PUBLIC_ prefix.',
    )
    this.name = 'SupabaseAdminUnavailable'
  }
}

/**
 * Built on first use rather than at module load, so a deployment without the
 * key still builds and still serves every read path. The write path is the
 * only thing that fails, and it fails saying which variable is missing.
 *
 * @throws {SupabaseAdminUnavailable} when the URL or service role key is absent.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'supabaseAdmin was imported into client code. The service role key is ' +
      'server-only and is not present in the browser bundle; move this call ' +
      'into a route handler or server component.',
    )
  }

  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) throw new SupabaseAdminUnavailable('NEXT_PUBLIC_SUPABASE_URL')
  if (!key) throw new SupabaseAdminUnavailable('SUPABASE_SERVICE_ROLE_KEY')

  cached = createClient(url, key, {
    // No session to persist and no token to refresh: this client is a request
    // handler, not a signed-in user. Left on, supabase-js keeps a refresh
    // timer alive per server instance for a session that never exists.
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}

/** Test seam. The client caches, and a suite that stubs env after first use
 *  would otherwise keep the client built from the previous values. */
export function resetSupabaseAdminForTests(): void {
  cached = null
}
