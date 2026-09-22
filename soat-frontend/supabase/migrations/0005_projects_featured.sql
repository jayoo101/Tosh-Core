-- ═══════════════════════════════════════════════════════════════════════════
-- projects.featured_until — an operator's pin on the homepage teaser.
--
-- Run after 0004. Safe to re-run.
--
-- ── What it overrides ─────────────────────────────────────────────────────
--
-- The "Active markets" block on `/` shows three launches and gives the first
-- one a double-width card. Until now the order was computed entirely from
-- chain state, in one sort in `AgentDirectoryHome.tsx`: filter to the launches
-- a visitor can act on, then rank by amount raised, descending.
--
-- That rule has a property nobody chose. Early in a deployment every raise
-- sits near zero, so the largest raise is a few units of quote — and the front
-- page's most valuable slot goes to whoever deposits one more unit than that.
-- Worse, a raise too small to carry a ladder refunds when its window closes,
-- so the deposit that bought the slot can be taken back. The top of the
-- homepage was rentable for gas and the patience to wait out a window.
--
-- This column is the editorial override. A row whose `featured_until` is in
-- the future sorts ahead of the raised-amount rule; everything else about the
-- block is unchanged, including which launches are eligible to appear in it at
-- all.
--
-- ── Why a timestamp and not a boolean ─────────────────────────────────────
--
-- A boolean needs a second deliberate act to turn it off, and that act is the
-- one that does not happen. The failure mode is specific and bad: a project
-- promoted for a launch week stays in the double-width card for months, so the
-- most prominent thing on the site becomes the least current, and a visitor
-- reading it as "what is happening now" is being misled by a control nobody
-- touched rather than by a claim anyone made.
--
-- An expiry inverts the default. Forgetting returns the page to the computed
-- order, which is the state the operator would have chosen anyway once the
-- promotion was stale. Setting it is a decision; keeping it is also a
-- decision, and has to be made again.
--
-- ── Not secret, and deliberately readable by anon ─────────────────────────
--
-- The sort runs in the browser, so the browser has to see this. `anon` already
-- has SELECT on every column of this table (0001) and that is unchanged here.
-- Nothing is given away: which project is in the big card is the most visible
-- fact on the site, and the expiry only says how long that will remain true.
--
-- WRITES ARE A DIFFERENT MATTER and are not opened up. `anon` still has no
-- INSERT or UPDATE — 0001's policies are untouched — so the only way to set
-- this is `POST /api/admin/featured`, which runs under the service role behind
-- a bearer credential. A column an unprivileged key could write would be a
-- column anyone could put themselves in the big card with, which is the
-- problem this is supposed to solve rather than a new way to have it.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ;

-- TIMESTAMPTZ rather than TIMESTAMP. The comparison happens against a browser
-- clock in whatever zone the reader is in, so a value with no zone would be
-- read as local time by the client and as UTC by Postgres — a pin that expires
-- at a different moment depending on who is looking at it.
COMMENT ON COLUMN public.projects.featured_until IS
  'While in the future, this launch sorts first in the homepage teaser and takes '
  'the double-width card. NULL or past means the computed order applies. Set only '
  'by POST /api/admin/featured under the service role; expiry is the default so a '
  'forgotten promotion lapses instead of persisting.';

-- ── The index the read path needs ─────────────────────────────────────────
--
-- Partial, because pinned rows are a handful out of the whole table and an
-- index over mostly-NULL is mostly dead weight. `chain_id` leads it for the
-- same reason every other index here does: both read paths carry
-- `WHERE chain_id = $1`, so an index that does not start there cannot be used
-- by them.
--
-- This exists for the route's own read rather than for `GET /api/projects`,
-- which selects every row for the chain and sorts in the browser. The route
-- has to find the current pin to clear it before setting a new one, and that
-- query is `WHERE chain_id = $1 AND featured_until IS NOT NULL`.
CREATE INDEX IF NOT EXISTS projects_chain_featured_idx
  ON public.projects (chain_id, featured_until DESC)
  WHERE featured_until IS NOT NULL;
