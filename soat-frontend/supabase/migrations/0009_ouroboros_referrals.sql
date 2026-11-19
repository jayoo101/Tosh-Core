-- ═══════════════════════════════════════════════════════════════════════════
-- Ouroboros partner referrals, settled off chain from the treasury.
--
-- `ouro_mints.ref_code` is read by the indexer from the tail of each mint's
-- call data (see `src/lib/ouroboros/ref.ts`), so only the minting wallet can
-- set it. An account binds to the first registered code it mints with, never
-- to its own link, and every later mint of that account accrues to the link at
-- the link's rate in force at that block.
--
-- Links and rates are written only by `/api/ouroboros/ref` after a Safe
-- signer's signature, payouts by that route or the indexer; partners read their own figures through the same
-- routes with their own signature. Nothing here is readable by `anon`.
-- Requires 0008. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.ouro_mints ADD COLUMN IF NOT EXISTS ref_code TEXT;
CREATE INDEX IF NOT EXISTS ouro_mints_ref_code ON public.ouro_mints (ref_code) WHERE ref_code IS NOT NULL;
-- 0008 lets anyone read the mint index; which code each wallet used is not
-- part of that, so the public grant becomes every column but `ref_code`.
REVOKE SELECT ON public.ouro_mints FROM anon, authenticated;
GRANT SELECT (tx_hash, log_index, stage, account, agent_key, shares, cost, tokens, first_share, paid_in_bnb, block_number)
  ON public.ouro_mints TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ouro_ref_links (
  code       TEXT        PRIMARY KEY CHECK (code ~ '^[a-z0-9]{3,16}$'),
  partner    TEXT        NOT NULL CHECK (partner ~ '^0x[0-9a-f]{40}$'),
  label      TEXT        NOT NULL DEFAULT '' CHECK (length(label) <= 64),
  created_by TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ouro_ref_links_partner ON public.ouro_ref_links (partner);

-- Append-only: a rate change is a new row from the block it was set at.
CREATE TABLE IF NOT EXISTS public.ouro_ref_rates (
  id              BIGSERIAL   PRIMARY KEY,
  code            TEXT        NOT NULL REFERENCES public.ouro_ref_links (code),
  rate_bps        INTEGER     NOT NULL CHECK (rate_bps BETWEEN 0 AND 2000),
  effective_block BIGINT      NOT NULL,
  set_by          TEXT        NOT NULL,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ouro_ref_rates_code_block ON public.ouro_ref_rates (code, effective_block DESC, id DESC);

-- One row per USDT transfer to a partner from the payout Safe (recorded by the
-- indexer) or the treasury (recorded by hand from a transaction hash).
CREATE TABLE IF NOT EXISTS public.ouro_ref_payouts (
  tx_hash      TEXT        NOT NULL,
  log_index    INTEGER     NOT NULL,
  partner      TEXT        NOT NULL CHECK (partner ~ '^0x[0-9a-f]{40}$'),
  amount       NUMERIC     NOT NULL,
  block_number BIGINT      NOT NULL,
  recorded_by  TEXT        NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ouro_ref_payouts_partner ON public.ouro_ref_payouts (partner);

CREATE OR REPLACE VIEW public.ouro_ref_bindings WITH (security_invoker = true) AS
  SELECT DISTINCT ON (m.account) m.account, m.ref_code AS code, l.partner, m.block_number, m.log_index
  FROM public.ouro_mints m
  JOIN public.ouro_ref_links l ON l.code = m.ref_code
  WHERE m.account <> l.partner
    AND EXISTS (SELECT 1 FROM public.ouro_ref_rates r WHERE r.code = l.code AND r.effective_block <= m.block_number)
  ORDER BY m.account, m.block_number, m.log_index;

CREATE OR REPLACE VIEW public.ouro_ref_accruals WITH (security_invoker = true) AS
  SELECT m.tx_hash, m.log_index, m.stage, m.account, b.code, b.partner, m.cost, m.block_number, r.rate_bps,
         FLOOR(m.cost * r.rate_bps / 10000) AS rebate
  FROM public.ouro_mints m
  JOIN public.ouro_ref_bindings b
    ON b.account = m.account AND (m.block_number, m.log_index) >= (b.block_number, b.log_index)
  CROSS JOIN LATERAL (
    SELECT rate_bps FROM public.ouro_ref_rates r
    WHERE r.code = b.code AND r.effective_block <= m.block_number
    ORDER BY r.effective_block DESC, r.id DESC LIMIT 1
  ) r;

CREATE OR REPLACE VIEW public.ouro_ref_link_stats WITH (security_invoker = true) AS
  SELECT l.code, l.partner, l.label, l.created_at,
         (SELECT rate_bps FROM public.ouro_ref_rates r WHERE r.code = l.code
          ORDER BY r.effective_block DESC, r.id DESC LIMIT 1) AS rate_bps,
         COUNT(DISTINCT a.account)::INTEGER AS accounts,
         COALESCE(SUM(a.cost), 0) AS volume,
         COALESCE(SUM(a.rebate), 0) AS accrued
  FROM public.ouro_ref_links l
  LEFT JOIN public.ouro_ref_accruals a ON a.code = l.code
  GROUP BY l.code, l.partner, l.label, l.created_at;

-- Summed here, not by the caller: a capped row read would understate `paid`
-- and autopay would send the difference again.
CREATE OR REPLACE VIEW public.ouro_ref_partner_balances WITH (security_invoker = true) AS
  SELECT COALESCE(a.partner, p.partner) AS partner,
         COALESCE(a.accrued, 0) AS accrued,
         COALESCE(p.paid, 0) AS paid,
         COALESCE(a.accrued, 0) - COALESCE(p.paid, 0) AS owed
  FROM (SELECT partner, SUM(rebate) AS accrued FROM public.ouro_ref_accruals GROUP BY partner) a
  FULL OUTER JOIN (SELECT partner, SUM(amount) AS paid FROM public.ouro_ref_payouts GROUP BY partner) p
    ON p.partner = a.partner;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ouro_ref_links', 'ouro_ref_rates', 'ouro_ref_payouts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ouro_ref_bindings', 'ouro_ref_accruals', 'ouro_ref_link_stats', 'ouro_ref_partner_balances'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.ouro_ref_rates_id_seq FROM anon, authenticated;

-- ── Automatic payouts (`app/lib/ouroAutopay.ts`, hourly cron) ─────────────────
-- A transfer is written here as soon as it is sent and removed once its
-- receipt is stored as a payout, so a run never pays what an earlier run has
-- in flight.
CREATE TABLE IF NOT EXISTS public.ouro_ref_pending (
  tx_hash    TEXT        PRIMARY KEY,
  -- The wallet that sent it, which need not be the payer any more.
  payer      TEXT        NOT NULL,
  partner    TEXT        NOT NULL,
  amount     NUMERIC     NOT NULL,
  nonce      BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A Safe signer's one-time approval of a run above the caps.
CREATE TABLE IF NOT EXISTS public.ouro_ref_approvals (
  id          BIGSERIAL   PRIMARY KEY,
  max_total   NUMERIC     NOT NULL CHECK (max_total > 0),
  approved_by TEXT        NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  -- Hash of the signed request, so one signature makes one approval.
  sig_hash    TEXT        UNIQUE
);
ALTER TABLE public.ouro_ref_approvals ADD COLUMN IF NOT EXISTS sig_hash TEXT UNIQUE;

-- One row: the run lock and the outcome of the last run.
CREATE TABLE IF NOT EXISTS public.ouro_ref_autopay (
  id           INTEGER     PRIMARY KEY CHECK (id = 1),
  locked_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  last_run_at  TIMESTAMPTZ,
  last_status  TEXT,
  last_detail  TEXT
);
INSERT INTO public.ouro_ref_autopay (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Returns the lock's expiry, which the holder passes back to release it, or
-- NULL while another run holds it.
DROP FUNCTION IF EXISTS public.ouro_ref_try_lock(INTEGER);
CREATE FUNCTION public.ouro_ref_try_lock(seconds INTEGER) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE token TIMESTAMPTZ;
BEGIN
  UPDATE public.ouro_ref_autopay SET locked_until = clock_timestamp() + make_interval(secs => seconds)
  WHERE id = 1 AND locked_until < NOW()
  RETURNING locked_until INTO token;
  RETURN token;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ouro_ref_pending', 'ouro_ref_approvals', 'ouro_ref_autopay'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.ouro_ref_approvals_id_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ouro_ref_try_lock(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ouro_ref_try_lock(INTEGER) TO service_role;