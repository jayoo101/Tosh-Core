import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client — shared singleton for both server and client usage.
//
// Required env vars (add to soat-frontend/.env.local):
//   NEXT_PUBLIC_SUPABASE_URL      — Project URL from Supabase dashboard
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — Public anon key (safe to expose)
//
// Supabase table DDL (run once in the SQL editor):
// ─────────────────────────────────────────────────────────────────────────────
// CREATE TABLE projects (
//   id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
//   tx_hash       TEXT        NOT NULL UNIQUE,
//   token_address TEXT,
//   hook_address  TEXT,
//   name          TEXT        NOT NULL,
//   symbol        TEXT        NOT NULL,
//   logo_url      TEXT,
//   website       TEXT,
//   twitter       TEXT,
//   telegram      TEXT,
//   description   TEXT,
//   created_at    TIMESTAMPTZ DEFAULT NOW()
// );
// ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "public read"  ON projects FOR SELECT USING (true);
// CREATE POLICY "service write" ON projects FOR INSERT WITH CHECK (true);
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
export const REGISTRY_READ_DEADLINE_MS = 1_200

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
