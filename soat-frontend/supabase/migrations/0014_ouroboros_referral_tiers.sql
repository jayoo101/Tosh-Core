-- ═══════════════════════════════════════════════════════════════════════════
-- Tiered partner rewards for fills after block 134805313 (2026-11-21 10:14
-- UTC+8). A partner's fills are numbered in chain order across all their
-- codes; fill n pays 0 USDT for n = 1, 1 for n = 2–4, 3 for n = 5–9 and 5 from
-- n = 10. Fills at or before the cutoff keep the amount of their link.
--
-- Drops the payout threshold of 0012/0013: everything accrued and unpaid is
-- owed. Requires 0010. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.ouro_ref_fill_rebates WITH (security_invoker = true) AS
  SELECT t.tx_hash, t.log_index, t.agent_key, t.code, t.partner,
         CASE WHEN t.block_number <= 134805313 THEN t.amount
              WHEN t.n = 1 THEN 0::NUMERIC
              WHEN t.n <= 4 THEN 1000000000000000000::NUMERIC
              WHEN t.n <= 9 THEN 3000000000000000000::NUMERIC
              ELSE 5000000000000000000::NUMERIC
         END AS rebate,
         t.block_number
  FROM (
    SELECT f.tx_hash, f.log_index, f.agent_key, b.code, b.partner, r.amount, f.block_number,
           ROW_NUMBER() OVER (PARTITION BY b.partner ORDER BY f.block_number, f.log_index) AS n
    FROM public.ouro_ref_agent_fills f
    JOIN public.ouro_ref_bindings b
      ON b.account = f.account AND (f.block_number, f.log_index) >= (b.block_number, b.log_index)
    CROSS JOIN LATERAL (
      SELECT amount FROM public.ouro_ref_bonuses x
      WHERE x.code = b.code AND x.effective_block <= f.block_number
      ORDER BY x.effective_block DESC, x.id DESC LIMIT 1
    ) r
  ) t;

CREATE OR REPLACE VIEW public.ouro_ref_partner_balances WITH (security_invoker = true) AS
  SELECT COALESCE(a.partner, p.partner) AS partner,
         COALESCE(a.accrued, 0) AS accrued,
         COALESCE(p.paid, 0) AS paid,
         COALESCE(a.accrued, 0) - COALESCE(p.paid, 0) AS owed
  FROM (SELECT partner, SUM(rebate) AS accrued FROM public.ouro_ref_fill_rebates GROUP BY partner) a
  FULL OUTER JOIN (SELECT partner, SUM(amount) AS paid FROM public.ouro_ref_payouts GROUP BY partner) p
    ON p.partner = a.partner;

REVOKE ALL ON public.ouro_ref_fill_rebates, public.ouro_ref_partner_balances FROM anon, authenticated;
