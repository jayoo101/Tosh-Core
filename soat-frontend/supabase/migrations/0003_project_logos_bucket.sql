-- ═══════════════════════════════════════════════════════════════════════════
-- project-logos — storage for token artwork, and the policies that decide who
-- may write it.
--
-- Run once against a fresh production project, in the SQL editor or via
-- `supabase db push`. It is safe to re-run.
--
-- ── Why this file exists ───────────────────────────────────────────────────
--
-- `projects.logo_url` accepted a URL and nothing else, so a launcher had to
-- host the image somewhere first. Most do not have anywhere, which is why the
-- directory is mostly letter sigils: the field existed, and the capability did
-- not. This bucket is the capability.
--
-- It also closes something the URL field could not. `ProjectLogo` renders a
-- raw `<img>` at whatever host the creator named, so every visitor's IP went
-- to a third party of the creator's choosing, on a site that took the trouble
-- to keep its own signers' names out of this repository. An upload keeps the
-- bytes on infrastructure we operate.
--
-- ── The rule, and why it is not the same as `projects` ─────────────────────
--
-- Reads are public: the bucket is `public = true`, so the object URL resolves
-- without a token, which is the whole point of a logo.
--
-- Writes come from `POST /api/projects/logo` holding the service role key, and
-- from nowhere else. `service_role` is BYPASSRLS in Supabase, so it needs no
-- policy here; the absence of an INSERT policy IS the denial for every other
-- role, exactly as in `0001_projects_rls.sql`.
--
-- The reason to keep `anon` out is narrower than it is for `projects` and
-- worth stating, because "it is only an image" is the argument that would undo
-- it. A writable bucket reachable with `NEXT_PUBLIC_SUPABASE_ANON_KEY` is an
-- open file host on our storage quota and our domain: anyone could park
-- arbitrary bytes under a name of their choosing and link them from anywhere.
-- The route is where the size cap, the magic-byte sniff and the rate limit
-- live, and none of those are expressible as a row predicate — so RLS cannot
-- re-derive them, and the only way to keep them load-bearing is to make the
-- route the sole writer.
--
-- ── Defence in depth on the bucket itself ─────────────────────────────────
--
-- `file_size_limit` and `allowed_mime_types` duplicate two of the route's
-- checks deliberately. They are the backstop for the case where a future
-- handler forgets one, and they are enforced by storage rather than by our
-- code, which is the only layer a bug in our code cannot talk its way past.
--
-- SVG is absent from the list on purpose. An SVG is a document, not a bitmap:
-- it can carry `<script>`, and it would be served from a domain that also
-- serves our own storage. There is no version of a token logo that needs it.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-logos',
  'project-logos',
  TRUE,
  1048576,  -- 1 MiB. Mirrors LOGO_MAX_BYTES in the route.
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

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
-- omission to be tidied up later — it is the rule. Adding one re-opens the
-- open file host described above.

DROP POLICY IF EXISTS project_logos_anon_write   ON storage.objects;
DROP POLICY IF EXISTS project_logos_anon_update  ON storage.objects;
DROP POLICY IF EXISTS project_logos_anon_delete  ON storage.objects;

COMMENT ON TABLE storage.objects IS
  'Supabase storage objects. The project-logos bucket is written only by '
  'POST /api/projects/logo under the service role, which caps size and sniffs '
  'magic bytes; see soat-frontend/supabase/migrations/0003_project_logos_bucket.sql.';
