import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client — shared singleton for both server and client usage.
//
// Required env vars (add to soat-frontend/.env.local):
//   NEXT_PUBLIC_SUPABASE_URL      — Project URL from Supabase dashboard
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — Public anon key (safe to expose)
//
// Schema and policies: `supabase/migrations/0001_projects_rls.sql`. They used
// to be a DDL comment here, which is how they came to be wrong — the policy
// this block prescribed was `FOR INSERT WITH CHECK (true)` with no `TO`
// clause, so it applied to `anon` as well, and `anon` is the role behind the
// key three lines up. That is a key we hand to every browser.
//
// The client below therefore READS. Writes go through `supabaseAdmin.ts` and
// the service role, because the checks that authorise one live in
// `POST /api/projects` and cannot be expressed as a row predicate.
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!supabaseUrl || !supabaseAnon) {
  throw new Error(
    'Missing Supabase env vars. Add NEXT_PUBLIC_SUPABASE_URL and ' +
    'NEXT_PUBLIC_SUPABASE_ANON_KEY to soat-frontend/.env.local'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnon)

// ─── Deadlines ───────────────────────────────────────────────────────────────
//
//  supabase-js ships no timeout AND retries four times with backoff, so an
//  unreachable project does not fail — it grinds. Measured against a host whose
//  TLS handshake was being reset: each attempt failed in ~1.65 s, and the call
//  settled after **13.9 s**. `GET /api/projects` returned its error after that
//  full span on every request, and `POST /api/projects` could hold the publish
//  step open just as long with the user's launch already mined and their gas
//  already spent.
//
//  The ceiling has to be on the OPERATION, not on one socket. A per-request
//  timeout in `global.fetch` was tried first and did nothing at all: every
//  individual attempt failed well inside it, and the time was going into the
//  retry chain between them. `.abortSignal()` bounds the whole chain, and was
//  measured settling at 1200 ms and 3003 ms against those deadlines exactly.
//
//  Every `supabase.from(...)` chain must carry one. `scripts/checkSupabase.mjs`
//  enforces that, because the bug this replaces was not a wrong value anywhere
//  — it was two of three call sites never having considered the question.

/**
 * Reads that a user is waiting on, where the page can render without the
 * answer. Presentation metadata only: name, logo, links. The directory and the
 * project page both fall back to chain state, so a miss costs polish, not
 * correctness, and it is not worth a visible stall.
 */
const REGISTRY_READ_DEADLINE_PROD_MS = 1_200

/**
 * The ceiling a developer machine gets instead, and why it exists.
 *
 * 1200 ms is sized for the deployment, where Vercel and Supabase share a
 * region. It is not sized for the FIRST read from a laptop on the other side
 * of an ocean, which pays DNS and a TLS handshake on top of the query.
 *
 * Measured from the machine this was written on, against this Supabase
 * project, `GET /api/projects` end to end:
 *
 *   cold, first request after `next dev` starts   2.8 s – 3.2 s   over budget
 *   warm, connection established                  0.88 s – 0.92 s  inside it
 *
 * So the steady state was never the problem and the deadline is not wrong
 * here — the cold start is, and it recurs on every dev server restart. The
 * symptom was that the directory's first paint after each restart aborted,
 * answered 503, and fell back to on-chain name and symbol with no registry
 * metadata, which looks exactly like a broken grid rather than a missed
 * deadline. `scripts/checkSupabaseRls.mjs` reports the cold number and
 * already warns that it is a reachability check and not a performance one.
 *
 * 5 s therefore, sized to absorb a cold handshake and nothing more; the same
 * budget the write path already uses. Long enough that the first paint
 * completes, short enough that a genuinely unreachable registry still gives
 * up rather than holding the page.
 *
 * This cannot loosen production: `NODE_ENV` is `'production'` in any real
 * build and `'test'` under vitest, and the assertion in
 * `api/projects/route.test.ts` pins the exported value at or below 2000 ms
 * from the test environment.
 */
const REGISTRY_READ_DEADLINE_DEV_MS = 5_000

export const REGISTRY_READ_DEADLINE_MS = resolveReadDeadline()

function resolveReadDeadline(): number {
  if (process.env.NODE_ENV !== 'development') return REGISTRY_READ_DEADLINE_PROD_MS

  // Opt-in override for a link even slower than the one above. Deliberately
  // not `NEXT_PUBLIC_`: this value is only ever read on the server, and
  // exposing it would let a bundled copy disagree with the server's.
  const raw = process.env.REGISTRY_READ_DEADLINE_MS
  if (raw === undefined) return REGISTRY_READ_DEADLINE_DEV_MS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[Tosh] REGISTRY_READ_DEADLINE_MS="${raw}" is not a positive number; ` +
      `using the ${REGISTRY_READ_DEADLINE_DEV_MS} ms development default.`
    )
    return REGISTRY_READ_DEADLINE_DEV_MS
  }
  return parsed
}

/**
 * Writes, which have no fallback. Longer than the read deadline because the
 * alternative to waiting is losing the row: by the time this runs the launch
 * transaction is already on chain, so a cut-off write leaves a real project
 * missing from the directory with nothing to retry from.
 */
export const REGISTRY_WRITE_DEADLINE_MS = 5_000

// ── Row shape (mirrors DB schema) ─────────────────────────────────────────────
export interface ProjectRow {
  id:            string
  /**
   * EIP-155 chain id the `tx_hash` belongs to. Both read paths filter on it;
   * see `supabase/migrations/0002_projects_chain_id.sql` for why a row without
   * it is a row that says "some launch, somewhere".
   */
  chain_id:      number
  tx_hash:       string
  token_address: string | null
  hook_address:  string | null
  name:          string
  symbol:        string
  logo_url:      string | null
  website:       string | null
  twitter:       string | null
  telegram:      string | null
  description:   string | null
  created_at:    string
}
