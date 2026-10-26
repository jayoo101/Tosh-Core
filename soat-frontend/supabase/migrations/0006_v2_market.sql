-- ═══════════════════════════════════════════════════════════════════════════
-- ToshX v2 — an index of BidBook and hook events.
--
-- Run once against production, in the SQL editor or via `supabase db push`.
-- Safe to re-run.
--
-- Everything here is DERIVED from chain logs by `POST /api/v2/index` and can
-- be dropped and rebuilt from `NEXT_PUBLIC_V2_FROM_BLOCK` at any time. Nothing
-- reads it as an authority on money: the bid market re-reads every bid from
-- the contract before it shows or routes into it, and only uses this table to
-- learn WHICH ids to read. A stale or wrong row costs a missing list entry,
-- never a wrong fill.
--
-- Writes are the indexer's alone (service role). Reads are public: every row
-- is a restatement of a public log.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.v2_bids (
  bid_id        NUMERIC     PRIMARY KEY,
  hook          TEXT        NOT NULL CHECK (hook   ~ '^0x[0-9a-f]{40}$'),
  bidder        TEXT        NOT NULL CHECK (bidder ~ '^0x[0-9a-f]{40}$'),
  price         NUMERIC     NOT NULL,
  qty           NUMERIC     NOT NULL,
  filled        NUMERIC     NOT NULL DEFAULT 0,
  escrow        NUMERIC     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  placed_block  BIGINT      NOT NULL,
  placed_tx     TEXT        NOT NULL,
  updated_block BIGINT      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS v2_bids_hook_status ON public.v2_bids (hook, status);
CREATE INDEX IF NOT EXISTS v2_bids_bidder ON public.v2_bids (bidder);

CREATE TABLE IF NOT EXISTS public.v2_fills (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  bid_id       NUMERIC NOT NULL,
  hook         TEXT    NOT NULL,
  seller       TEXT    NOT NULL,
  qty          NUMERIC NOT NULL,
  price        NUMERIC NOT NULL,
  gross        NUMERIC NOT NULL,
  buyer_fee    NUMERIC NOT NULL,
  seller_fee   NUMERIC NOT NULL,
  block_number BIGINT  NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS v2_fills_hook_block ON public.v2_fills (hook, block_number DESC);
CREATE INDEX IF NOT EXISTS v2_fills_seller ON public.v2_fills (seller);

CREATE TABLE IF NOT EXISTS public.v2_genesis_buys (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  hook         TEXT    NOT NULL,
  buyer        TEXT    NOT NULL,
  agent_key    TEXT    NOT NULL,
  paid         NUMERIC NOT NULL,
  tokens       NUMERIC NOT NULL,
  sold_after   NUMERIC NOT NULL,
  block_number BIGINT  NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS v2_genesis_buys_hook_block ON public.v2_genesis_buys (hook, block_number DESC);
CREATE INDEX IF NOT EXISTS v2_genesis_buys_buyer ON public.v2_genesis_buys (buyer);

-- SoldOut, Launched, ProjectFundChanged, FundWithdrawn, LaunchCreated.
CREATE TABLE IF NOT EXISTS public.v2_project_events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  hook         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  data         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  block_number BIGINT  NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS v2_project_events_hook ON public.v2_project_events (hook, block_number DESC);

-- One row per indexer cursor. `last_block` is inclusive.
CREATE TABLE IF NOT EXISTS public.v2_indexer_state (
  id         TEXT        PRIMARY KEY,
  last_block BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['v2_bids', 'v2_fills', 'v2_genesis_buys', 'v2_project_events', 'v2_indexer_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_public_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t || '_public_read', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
  END LOOP;
END $$;
