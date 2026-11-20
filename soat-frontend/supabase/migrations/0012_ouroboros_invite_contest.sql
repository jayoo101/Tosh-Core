-- ═══════════════════════════════════════════════════════════════════════════
-- Invite contest: payable balance follows contest awards, not the previous
-- calculator. Requires 0010.
--
-- Safe to re-run. Does not DELETE or UPDATE public.ouro_ref_payouts,
-- public.ouro_ref_pending, public.ouro_ref_links or public.ouro_ref_bonuses.
-- The previous fill calculator is copied once into
-- public.ouro_ref_legacy_fill_snapshot and then no longer drives payment.
-- Unpaid rows of that old calculator are not turned into new transfers.
-- Awards themselves are written by the app (`app/lib/ouroContest.ts`) after
-- this migration; an empty award table means nothing is payable yet.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.ouro_mints ADD COLUMN IF NOT EXISTS tx_index INTEGER;

CREATE TABLE IF NOT EXISTS public.ouro_ref_legacy_fill_snapshot (
  tx_hash        TEXT        NOT NULL,
  log_index      INTEGER     NOT NULL,
  agent_key      TEXT        NOT NULL,
  code           TEXT        NOT NULL,
  partner        TEXT        NOT NULL,
  rebate         NUMERIC     NOT NULL,
  block_number   BIGINT      NOT NULL,
  snapshotted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index)
);

DO $$
BEGIN
  IF to_regclass('public.ouro_ref_fill_rebates') IS NOT NULL THEN
    INSERT INTO public.ouro_ref_legacy_fill_snapshot
      (tx_hash, log_index, agent_key, code, partner, rebate, block_number)
    SELECT tx_hash, log_index, agent_key, code, partner, rebate, block_number
    FROM public.ouro_ref_fill_rebates
    ON CONFLICT (tx_hash, log_index) DO NOTHING;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ouro_ref_contest_bounds (
  id          INTEGER     PRIMARY KEY CHECK (id = 1),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  start_block BIGINT,
  end_block   BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.ouro_ref_contest_bounds (id, starts_at, ends_at)
VALUES (1, '2026-11-20 14:00:00+00', '2026-11-27 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- One row per Agent ID the app currently considers. Status `payable` is the
-- only one the hourly job may send. Settlements point at a payout that
-- already exists; inserting one does not move funds.
CREATE TABLE IF NOT EXISTS public.ouro_ref_contest_awards (
  agent_key      TEXT        PRIMARY KEY,
  account        TEXT        NOT NULL,
  code           TEXT        NOT NULL,
  partner        TEXT        NOT NULL,
  fill_tx_hash   TEXT        NOT NULL,
  fill_log_index INTEGER     NOT NULL,
  fill_tx_index  INTEGER     NOT NULL,
  fill_block     BIGINT      NOT NULL,
  amount         NUMERIC     NOT NULL CHECK (amount = 5000000000000000000),
  rank           INTEGER     NOT NULL CHECK (rank > 0),
  status         TEXT        NOT NULL CHECK (status IN ('payable', 'held', 'over_cap', 'withdrawn')),
  reason         TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ouro_ref_contest_awards_partner ON public.ouro_ref_contest_awards (partner, status);

CREATE TABLE IF NOT EXISTS public.ouro_ref_contest_reviews (
  id          BIGSERIAL   PRIMARY KEY,
  agent_key   TEXT        NOT NULL,
  decision    TEXT        NOT NULL CHECK (decision IN ('hold', 'disqualify', 'clear', 'assign')),
  account     TEXT,
  code        TEXT,
  partner     TEXT,
  reason      TEXT        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  reviewed_by TEXT        NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ouro_ref_contest_reviews_agent ON public.ouro_ref_contest_reviews (agent_key, reviewed_at, id);

CREATE TABLE IF NOT EXISTS public.ouro_ref_contest_settlements (
  agent_key    TEXT        PRIMARY KEY,
  partner      TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL CHECK (amount = 5000000000000000000),
  tx_hash      TEXT        NOT NULL,
  log_index    INTEGER     NOT NULL,
  recorded_by  TEXT        NOT NULL,
  reason       TEXT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment view. `owed` is unsettled payable prizes only. Historical rows in
-- ouro_ref_payouts stay listed there and are not subtracted here, so a
-- pre-contest transfer is not treated as payment of a new prize. Linking
-- those on purpose is an admin action that inserts a settlement.
CREATE OR REPLACE VIEW public.ouro_ref_partner_balances WITH (security_invoker = true) AS
SELECT COALESCE(a.partner, s.partner) AS partner,
       COALESCE(a.accrued, 0) AS accrued,
       COALESCE(s.paid, 0) AS paid,
       COALESCE(a.unpaid, 0) AS owed
FROM (
  SELECT partner,
         COALESCE(SUM(amount) FILTER (WHERE status = 'payable'), 0) AS accrued,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'payable'
             AND NOT EXISTS (
               SELECT 1 FROM public.ouro_ref_contest_settlements st
               WHERE st.agent_key = public.ouro_ref_contest_awards.agent_key
             )
         ), 0) AS unpaid
  FROM public.ouro_ref_contest_awards
  GROUP BY partner
) a
FULL OUTER JOIN (
  SELECT partner, COALESCE(SUM(amount), 0) AS paid
  FROM public.ouro_ref_contest_settlements
  GROUP BY partner
) s ON s.partner = a.partner;

CREATE OR REPLACE VIEW public.ouro_ref_fill_rebates WITH (security_invoker = true) AS
SELECT fill_tx_hash AS tx_hash,
       fill_log_index AS log_index,
       agent_key,
       code,
       partner,
       amount AS rebate,
       fill_block AS block_number
FROM public.ouro_ref_contest_awards
WHERE status = 'payable';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ouro_ref_legacy_fill_snapshot',
    'ouro_ref_contest_bounds',
    'ouro_ref_contest_awards',
    'ouro_ref_contest_reviews',
    'ouro_ref_contest_settlements'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON public.ouro_ref_partner_balances, public.ouro_ref_fill_rebates FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ouro_ref_contest_reviews_id_seq FROM anon, authenticated;
