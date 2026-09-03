-- ═══════════════════════════════════════════════════════════════════════════
-- projects — directory presentation metadata, and the policies that decide
-- who may write it.
--
-- Run once against a fresh production project, in the SQL editor or via
-- `supabase db push`. It is safe to re-run.
--
-- ── Why this file exists ───────────────────────────────────────────────────
--
-- The schema previously lived in a comment block in `src/app/lib/supabase.ts`,
-- and the policy it prescribed was:
--
--     CREATE POLICY "service write" ON projects FOR INSERT WITH CHECK (true);
--
-- The name says service. The SQL does not: a policy with no `TO` clause
-- applies to PUBLIC, which includes `anon` — and `anon` is the role behind
-- NEXT_PUBLIC_SUPABASE_ANON_KEY, a value that is handed to every browser by
-- design. Applied as written, anyone who opened devtools could POST rows
-- straight to PostgREST and skip the API route entirely.
--
-- Skipping the route is the whole problem, because the route is where the
-- checks are: it reads the launch from chain by tx_hash, recovers the signer
-- from a personal_sign attestation, requires that signer to equal
-- `launch.creator`, and copies name/symbol/token_address/hook_address from
-- chain state rather than from the request body. None of that is expressible
-- as a row predicate, so RLS cannot re-derive it — the only way to keep those
-- checks load-bearing is to make the route the sole writer.
--
-- The sharpest version of the bypass was a squat: `tx_hash` is UNIQUE, so an
-- attacker who inserted a row for a real launch before its creator published
-- would own that project's logo and outbound links, and the creator's own
-- publish would come back `{ ok: true, duplicate: true }` — a 200. They would
-- be told it worked.
--
-- ── The rule ──────────────────────────────────────────────────────────────
--
-- Reads are public. Writes come from the API route holding the service role
-- key, and from nowhere else. `service_role` is BYPASSRLS in Supabase, so it
-- needs no policy here; the absence of a write policy IS the denial for every
-- other role, and the REVOKEs below say the same thing a second way at the
-- grant layer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.projects (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  tx_hash       TEXT        NOT NULL UNIQUE,
  token_address TEXT,
  hook_address  TEXT,
  name          TEXT        NOT NULL,
  symbol        TEXT        NOT NULL,
  logo_url      TEXT,
  website       TEXT,
  twitter       TEXT,
  telegram      TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- The directory lists newest first and looks rows up by token address; both
-- are hot paths on the project page. `tx_hash` is already indexed by UNIQUE.
CREATE INDEX IF NOT EXISTS projects_created_at_idx
  ON public.projects (created_at DESC);
CREATE INDEX IF NOT EXISTS projects_token_address_idx
  ON public.projects (token_address);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- FORCE also subjects the table OWNER to these policies. Without it, a future
-- migration or dashboard action running as `postgres` writes unimpeded, which
-- is how a table ends up protected everywhere except the one session someone
-- actually used. `service_role` is unaffected — BYPASSRLS outranks FORCE.
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;

-- Correct the earlier prescription if it was ever applied.
DROP POLICY IF EXISTS "public read"   ON public.projects;
DROP POLICY IF EXISTS "service write" ON public.projects;

DROP POLICY IF EXISTS projects_public_read ON public.projects;
CREATE POLICY projects_public_read
  ON public.projects
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Deliberately no INSERT, UPDATE or DELETE policy. Under RLS a missing policy
-- denies, so this is not an omission to be tidied up later — it is the rule.
-- Adding one for `anon` re-opens the bypass above.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.projects FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.projects FROM authenticated;
GRANT  SELECT ON public.projects TO anon, authenticated;

COMMENT ON TABLE public.projects IS
  'Directory presentation metadata. Writes come only from POST /api/projects, '
  'which authenticates the creator against chain state; see '
  'supabase/migrations/0001_projects_rls.sql for why RLS cannot express that '
  'check itself.';
