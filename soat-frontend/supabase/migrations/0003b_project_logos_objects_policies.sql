-- ═══════════════════════════════════════════════════════════════════════════
-- project-logos — OPTIONAL `storage.objects` policies.
--
-- OPTIONAL is a claim about behaviour, not a hedge. Uploads and public reads
-- work with `0003_project_logos_bucket.sql` alone:
--
--   • reads resolve because the bucket is `public = true`, which Supabase
--     storage honours before it consults any row policy;
--   • writes come from `POST /api/projects/logo` under the service role, and
--     `service_role` is BYPASSRLS, so no policy grants it anything.
--
-- What this file adds is a second, explicit statement of the same rule at the
-- row level, so that flipping the bucket to `public = false` — or a future
-- handler reaching `storage.objects` with a weaker role — still lands on the
-- intended answer. Skipping it costs that backstop and nothing else.
--
-- ── Why it is a separate file ──────────────────────────────────────────────
--
-- `storage.objects` is owned by `supabase_storage_admin`. The dashboard SQL
-- editor connects as `postgres`, which is not that owner, so `CREATE POLICY`
-- and `COMMENT ON TABLE` against it fail with:
--
--     ERROR: 42501: must be owner of table objects
--
-- The editor wraps a script in a single transaction, so when these statements
-- lived at the bottom of `0003` they took the bucket INSERT down with them.
-- That is the exact mechanism by which `0003` was never applied: an operator
-- pasted it, saw a permission error about a table they had not been thinking
-- about, and every logo upload in production returned 502 for four days.
-- Keeping them here means the failure, if it happens, is confined to the part
-- that is genuinely optional.
--
-- ── How to apply it ────────────────────────────────────────────────────────
--
-- Pick whichever is available; none of them is required:
--
--   1. `supabase db push` — the CLI connects as the database owner and has the
--      necessary rights. This is the path that works unattended.
--   2. Dashboard → Storage → Policies → project-logos. The UI issues the same
--      DDL through the storage service, which does hold ownership.
--   3. A direct `psql` session as `supabase_storage_admin` using the connection
--      string from Settings → Database.
--
-- If you get 42501, you are on path 1's role without path 1's connection. Use
-- the UI and move on — `npm run check:storage` verifies the part that matters.
-- ═══════════════════════════════════════════════════════════════════════════

-- `storage.objects` already has RLS enabled by Supabase; these policies scope
-- to this bucket and leave every other bucket's rules untouched.

DROP POLICY IF EXISTS project_logos_public_read ON storage.objects;
CREATE POLICY project_logos_public_read
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'project-logos');

-- Deliberately no INSERT, UPDATE or DELETE policy for `anon` or
-- `authenticated`. Under RLS a missing policy denies, so this is not an
-- omission to be tidied up later — it is the rule. Adding one turns the bucket
-- into an open file host on our storage quota and our domain; see the
-- reasoning in `0003_project_logos_bucket.sql`.

DROP POLICY IF EXISTS project_logos_anon_write   ON storage.objects;
DROP POLICY IF EXISTS project_logos_anon_update  ON storage.objects;
DROP POLICY IF EXISTS project_logos_anon_delete  ON storage.objects;

COMMENT ON TABLE storage.objects IS
  'Supabase storage objects. The project-logos bucket is written only by '
  'POST /api/projects/logo under the service role, which caps size and sniffs '
  'magic bytes; see soat-frontend/supabase/migrations/0003_project_logos_bucket.sql.';
