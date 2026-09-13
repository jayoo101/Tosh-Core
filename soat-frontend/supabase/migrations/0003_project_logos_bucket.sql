-- ═══════════════════════════════════════════════════════════════════════════
-- project-logos — the storage bucket for token artwork.
--
-- This file is the one that makes uploads work. The optional `storage.objects`
-- policies are in `0003b_project_logos_objects_policies.sql`.
--
-- Run once against a fresh production project, in the SQL editor or via
-- `supabase db push`. It is safe to re-run.
--
-- ── This file used to be unrunnable, which is why it never ran ─────────────
--
-- Until 2026-09-13 it also carried `CREATE POLICY` and `COMMENT ON TABLE`
-- against `storage.objects`. That table is owned by `supabase_storage_admin`,
-- not by the `postgres` role the dashboard SQL editor connects as, so the
-- editor answers `ERROR: 42501: must be owner of table objects` — and because
-- it runs the script as one transaction, the `storage.buckets` INSERT above it
-- rolled back too. The file therefore could not be applied by the one route an
-- operator would reach for, and it had not been: production answered
-- `NoSuchBucket`, `POST /api/projects/logo` returned 502 for every upload by
-- everybody, and nothing in the test suite or the guards noticed, because
-- nothing checks whether a migration in this directory reached the database.
--
-- Those statements now live in `0003b_project_logos_objects_policies.sql`,
-- which is defence in depth and NOT required for uploads to work — see that
-- file's header. `npm run check:storage` probes the deployed bucket, so the
-- drift that hid this is now detectable from a clean checkout.
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

-- Nothing below this line. The `storage.objects` policies moved to
-- `0003b_project_logos_objects_policies.sql` so that this file — the one that
-- actually decides whether uploads work — can be applied from the dashboard SQL
-- editor without hitting a permission error on a different table.
