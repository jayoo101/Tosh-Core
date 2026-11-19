-- ═══════════════════════════════════════════════════════════════════════════
-- Partner rebates as a fixed USDT amount per Agent ID, paid once when that
-- Agent ID's shares reach the cap (30, L1 and L2 together).
--
-- Replaces the percentage rebate of 0009: `ouro_ref_rates` stays as history
-- and is no longer read. A link's amount is append-only in `ouro_ref_bonuses`;
-- a fill accrues at the amount in force at the block where it completes.
-- Requires 0009. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ouro_ref_bonuses (
  id              BIGSERIAL   PRIMARY KEY,
  code            TEXT        NOT NULL REFERENCES public.ouro_ref_links (code),
  -- USDT wei, as on the chain (USDT has 18 decimals on BSC).
  amount          NUMERIC     NOT NULL CHECK (amount > 0),
  effective_block BIGINT      NOT NULL,
  set_by          TEXT        NOT NULL,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ouro_ref_bonuses_code_block ON public.ouro_ref_bonuses (code, effective_block DESC, id DESC);

ALTER TABLE public.ouro_ref_bonuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ouro_ref_bonuses FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ouro_ref_bonuses FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ouro_ref_bonuses_id_seq FROM anon, authenticated;

-- Views are rebuilt from the bottom up; the dependents go first.
DROP VIEW IF EXISTS public.ouro_ref_partner_balances;
DROP VIEW IF EXISTS public.ouro_ref_link_stats;
DROP VIEW IF EXISTS public.ouro_ref_fill_rebates;
DROP VIEW IF EXISTS public.ouro_ref_agent_fills;
DROP VIEW IF EXISTS public.ouro_ref_accruals;
DROP VIEW IF EXISTS public.ouro_ref_bindings;

-- A link binds an account at its first mint once it has an amount in force.
CREATE OR REPLACE VIEW public.ouro_ref_bindings WITH (security_invoker = true) AS
  SELECT DISTINCT ON (m.account) m.account, m.ref_code AS code, l.partner, m.block_number, m.log_index
  FROM public.ouro_mints m
  JOIN public.ouro_ref_links l ON l.code = m.ref_code
  WHERE m.account <> l.partner
    AND EXISTS (SELECT 1 FROM public.ouro_ref_bonuses b WHERE b.code = l.code AND b.effective_block <= m.block_number)
  ORDER BY m.account, m.block_number, m.log_index;

-- Every mint an account made after it bound, for volume and the account count.
CREATE OR REPLACE VIEW public.ouro_ref_accruals WITH (security_invoker = true) AS
  SELECT m.tx_hash, m.log_index, m.stage, m.account, b.code, b.partner, m.cost, m.block_number
  FROM public.ouro_mints m
  JOIN public.ouro_ref_bindings b
    ON b.account = m.account AND (m.block_number, m.log_index) >= (b.block_number, b.log_index);

-- The mint at which each Agent ID's shares first reach 30 (cap, L1 and L2 together).
CREATE OR REPLACE VIEW public.ouro_ref_agent_fills WITH (security_invoker = true) AS
  SELECT t.tx_hash, t.log_index, t.agent_key, t.account, t.block_number
  FROM (
    SELECT m.tx_hash, m.log_index, m.agent_key, m.account, m.block_number, m.shares,
           SUM(m.shares) OVER (PARTITION BY m.agent_key ORDER BY m.block_number, m.log_index) AS cum
    FROM public.ouro_mints m
  ) t
  WHERE t.cum >= 30 AND t.cum - t.shares < 30;

-- The fixed amount owed for each such fill, to the link its account is bound to.
CREATE OR REPLACE VIEW public.ouro_ref_fill_rebates WITH (security_invoker = true) AS
  SELECT f.tx_hash, f.log_index, f.agent_key, b.code, b.partner, r.amount AS rebate, f.block_number
  FROM public.ouro_ref_agent_fills f
  JOIN public.ouro_ref_bindings b
    ON b.account = f.account AND (f.block_number, f.log_index) >= (b.block_number, b.log_index)
  CROSS JOIN LATERAL (
    SELECT amount FROM public.ouro_ref_bonuses x
    WHERE x.code = b.code AND x.effective_block <= f.block_number
    ORDER BY x.effective_block DESC, x.id DESC LIMIT 1
  ) r;

CREATE OR REPLACE VIEW public.ouro_ref_link_stats WITH (security_invoker = true) AS
  SELECT l.code, l.partner, l.label, l.created_at,
         (SELECT amount FROM public.ouro_ref_bonuses x WHERE x.code = l.code
          ORDER BY x.effective_block DESC, x.id DESC LIMIT 1) AS bonus,
         COUNT(DISTINCT a.account)::INTEGER AS accounts,
         COALESCE(SUM(a.cost), 0) AS volume,
         COALESCE((SELECT SUM(fr.rebate) FROM public.ouro_ref_fill_rebates fr WHERE fr.code = l.code), 0) AS accrued
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
  FROM (SELECT partner, SUM(rebate) AS accrued FROM public.ouro_ref_fill_rebates GROUP BY partner) a
  FULL OUTER JOIN (SELECT partner, SUM(amount) AS paid FROM public.ouro_ref_payouts GROUP BY partner) p
    ON p.partner = a.partner;

REVOKE ALL ON public.ouro_ref_bindings, public.ouro_ref_accruals, public.ouro_ref_agent_fills,
  public.ouro_ref_fill_rebates, public.ouro_ref_link_stats, public.ouro_ref_partner_balances
  FROM anon, authenticated;
