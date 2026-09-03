-- ═══════════════════════════════════════════════════════════════════════════
-- projects.chain_id — which chain a row is about.
--
-- Run after 0001. Safe to re-run.
--
-- ── Why this file exists ───────────────────────────────────────────────────
--
-- 0001 got the question of WHO may write right, and left the question of WHAT
-- a row is about unasked. A row identified a launch by `tx_hash` alone, and a
-- transaction hash does not name a chain.
--
-- `POST /api/projects` already guards the write path carefully. It reads the
-- launch from the receipt rather than the request body, and it refuses to run
-- if the RPC does not report the chain id the deployment claims:
--
--     Read it from the wrong one and a launch minted on a free testnet
--     authenticates a listing in the mainnet directory: the caller genuinely
--     is that launch's creator, the signature genuinely verifies, and the row
--     is still a forgery.
--
-- That comment names this hazard exactly. The check under it defends the write
-- path's own consistency — it cannot defend which directory the row lands in,
-- because the row carried no chain identity to sort it by. Both reads
-- (`GET /api/projects`, and `getProject.ts` matching on token/hook address)
-- selected every row in the table.
--
-- So a single Supabase project served by two deployments — a staging build on
-- 46630 and production on 4663 — mixes them, with every individual write
-- correctly authenticated. Nothing is forged in the sense the write path
-- checks for. The rows are simply about a different chain than the reader.
--
-- It does not take two deployments. One deployment repointed does it too: the
-- testnet rehearsals that precede a mainnet cutover write rows that the
-- mainnet directory then reads as its own.
--
-- ── Why now rather than later ─────────────────────────────────────────────
--
-- Backfill. While the table is empty this is a column addition. Afterwards it
-- means deciding which chain each existing row came from, and the only
-- evidence in the row is `tx_hash` — which has to be probed against every
-- chain the deployment has ever pointed at, in an order that hopes no two
-- chains ever mined the same hash.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS chain_id BIGINT;

-- BIGINT, not INTEGER: EIP-155 chain ids are not bounded by 2^31 and several
-- live chains already exceed it.

COMMENT ON COLUMN public.projects.chain_id IS
  'EIP-155 chain id the tx_hash belongs to. Both read paths filter on it; '
  'without it a staging deployment and production sharing this project would '
  'show each other''s launches.';

-- Only defensible on an empty table, which is why this migration is being run
-- now. If rows exist without a chain_id, this fails loudly rather than
-- guessing — see the backfill note above.
DO $$
DECLARE
  orphans BIGINT;
BEGIN
  SELECT count(*) INTO orphans FROM public.projects WHERE chain_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'projects has % row(s) with no chain_id. Set them before this migration '
      'can add NOT NULL; each row''s chain has to be established from its '
      'tx_hash against the chains this deployment has served, because nothing '
      'in the row records it.', orphans;
  END IF;
END $$;

ALTER TABLE public.projects
  ALTER COLUMN chain_id SET NOT NULL;

-- ── Uniqueness moves with it ──────────────────────────────────────────────
--
-- `tx_hash` alone was UNIQUE. That is wrong in both directions once chains are
-- distinguished: it forbids the same hash on two chains (improbable but not
-- prohibited), and, more to the point, it was the constraint the route's
-- duplicate handling relies on to mean "this creator already published this
-- launch". Scoped to a chain, it means that again.
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_tx_hash_key;

DROP INDEX IF EXISTS projects_chain_tx_key;
CREATE UNIQUE INDEX projects_chain_tx_key
  ON public.projects (chain_id, tx_hash);

-- ── Indexes the filtered reads need ───────────────────────────────────────
--
-- Both hot paths now carry `WHERE chain_id = $1`, so the 0001 indexes are no
-- longer selective enough to be used. Replace them with leading-chain_id
-- composites rather than leaving both sets in place.
DROP INDEX IF EXISTS projects_created_at_idx;
DROP INDEX IF EXISTS projects_token_address_idx;

CREATE INDEX IF NOT EXISTS projects_chain_created_at_idx
  ON public.projects (chain_id, created_at DESC);
CREATE INDEX IF NOT EXISTS projects_chain_token_address_idx
  ON public.projects (chain_id, token_address);
CREATE INDEX IF NOT EXISTS projects_chain_hook_address_idx
  ON public.projects (chain_id, hook_address);

-- Policies are unchanged: 0001's rule is about who writes, and this file is
-- about what a row means. anon still reads everything it is shown and writes
-- nothing; the chain filter is applied by the application, because it is a
-- property of the deployment rather than of the caller.
