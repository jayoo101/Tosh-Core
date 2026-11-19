-- ═══════════════════════════════════════════════════════════════════════════
-- Ouroboros — an index of OuroborosMint and OuroborosBidBook events, and the
-- three leaderboards built on it (L1 seeding, L1.5 turnover, L2 minting).
--
-- Derived entirely from chain logs by `POST /api/ouroboros/index`; drop and
-- rebuild from `NEXT_PUBLIC_OURO_FROM_BLOCK` at any time; a rebuild re-runs
-- 0009 after this file, which adds `ouro_mints.ref_code` and the views on it.
-- The cursor lives in `v2_indexer_state` under id 'ouroboros'. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ouro_mints (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  stage        TEXT    NOT NULL CHECK (stage IN ('L1', 'L2')),
  account      TEXT    NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  agent_key    TEXT    NOT NULL,
  shares       INTEGER NOT NULL,
  cost         NUMERIC NOT NULL,
  tokens       NUMERIC NOT NULL DEFAULT 0,
  first_share  BIGINT,
  paid_in_bnb  BOOLEAN NOT NULL,
  block_number BIGINT  NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ouro_mints_stage_block ON public.ouro_mints (stage, block_number DESC);
CREATE INDEX IF NOT EXISTS ouro_mints_account ON public.ouro_mints (account);

CREATE TABLE IF NOT EXISTS public.ouro_bids (
  bid_id        NUMERIC PRIMARY KEY,
  buyer         TEXT    NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  price         NUMERIC NOT NULL,
  usdt_amount   NUMERIC NOT NULL,
  usdt_left     NUMERIC NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
  placed_block  BIGINT  NOT NULL,
  updated_block BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS ouro_bids_status_price ON public.ouro_bids (status, price DESC);
CREATE INDEX IF NOT EXISTS ouro_bids_buyer ON public.ouro_bids (buyer);

CREATE TABLE IF NOT EXISTS public.ouro_fills (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  bid_id       NUMERIC NOT NULL,
  buyer        TEXT    NOT NULL,
  seller       TEXT    NOT NULL,
  tokens       NUMERIC NOT NULL,
  usdt_gross   NUMERIC NOT NULL,
  block_number BIGINT  NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ouro_fills_block ON public.ouro_fills (block_number DESC);

-- Leaderboards. `security_invoker` so the views read through the tables' RLS.
CREATE OR REPLACE VIEW public.ouro_lb_l1 WITH (security_invoker = true) AS
  SELECT account, SUM(shares)::INTEGER AS shares, SUM(cost) AS volume, MIN(block_number) AS first_block
  FROM public.ouro_mints WHERE stage = 'L1' GROUP BY account;

CREATE OR REPLACE VIEW public.ouro_lb_l2 WITH (security_invoker = true) AS
  SELECT account, SUM(shares)::INTEGER AS shares, SUM(cost) AS volume, MIN(block_number) AS first_block
  FROM public.ouro_mints WHERE stage = 'L2' GROUP BY account;

CREATE OR REPLACE VIEW public.ouro_lb_l15 WITH (security_invoker = true) AS
  SELECT account, COUNT(*)::INTEGER AS fills, SUM(usdt_gross) AS volume, MIN(block_number) AS first_block
  FROM (
    SELECT buyer AS account, usdt_gross, block_number FROM public.ouro_fills
    UNION ALL
    -- A fill of one's own bid counts once.
    SELECT seller AS account, usdt_gross, block_number FROM public.ouro_fills WHERE seller <> buyer
  ) s
  GROUP BY account;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ouro_mints', 'ouro_bids', 'ouro_fills'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_public_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t || '_public_read', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ouro_lb_l1', 'ouro_lb_l2', 'ouro_lb_l15'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
  END LOOP;
END $$;

-- Run locks for the cron jobs: `ouro_try_lock` returns the lock's expiry,
-- which the holder passes to `ouro_release_lock`, or NULL while it is held.
CREATE TABLE IF NOT EXISTS public.ouro_locks (
  name         TEXT        PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);
ALTER TABLE public.ouro_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ouro_locks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ouro_locks FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.ouro_try_lock(lock_name TEXT, seconds INTEGER) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE token TIMESTAMPTZ;
BEGIN
  INSERT INTO public.ouro_locks (name) VALUES (lock_name) ON CONFLICT (name) DO NOTHING;
  UPDATE public.ouro_locks SET locked_until = clock_timestamp() + make_interval(secs => seconds)
  WHERE name = lock_name AND locked_until < NOW()
  RETURNING locked_until INTO token;
  RETURN token;
END $$;

CREATE OR REPLACE FUNCTION public.ouro_release_lock(lock_name TEXT, token TIMESTAMPTZ) RETURNS VOID
LANGUAGE sql SET search_path = public AS $$
  UPDATE public.ouro_locks SET locked_until = 'epoch' WHERE name = lock_name AND locked_until = token;
$$;

REVOKE EXECUTE ON FUNCTION public.ouro_try_lock(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ouro_release_lock(TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ouro_try_lock(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.ouro_release_lock(TEXT, TIMESTAMPTZ) TO service_role;
