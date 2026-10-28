-- ═══════════════════════════════════════════════════════════════════════════
-- projects.cover_url — a 16:9 cover for the featured card.
--
-- Run after 0006. Safe to re-run.
--
-- The homepage shows one featured raise as a wide card, and its left half is
-- the cover. Without one the card builds a cover from the logo (blurred to fill
-- the frame, sharp in the middle), which reads fine for a colourful logo and
-- as a grey slab for a black-and-white one.
--
-- Set by the platform, not by the launcher. The image is chosen and reviewed
-- by whoever pins the raise, through `POST /api/admin/featured` under the
-- service role, so the launch form gains no field and nothing a launcher
-- uploads reaches the largest picture on the site unreviewed. `anon` keeps
-- SELECT (0001) and still has no UPDATE.
--
-- The route only accepts objects in our own `project-logos` bucket (0003), so a
-- cover never points visitors' browsers at a third-party host.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cover_url TEXT;

COMMENT ON COLUMN public.projects.cover_url IS
  'Optional 16:9 cover shown on project cards. NULL means the card builds one from '
  'logo_url. Set only by POST /api/admin/featured under the service role, and only '
  'to an object in the project-logos bucket.';
