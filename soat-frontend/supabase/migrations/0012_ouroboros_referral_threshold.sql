-- ═══════════════════════════════════════════════════════════════════════════
-- A partner is owed nothing until at least 3 Agent IDs bound to their links
-- (all their codes together) have filled 30 shares. From the third fill on,
-- every fill so far is owed, net of what was already paid.
--
-- Rewards still accrue per fill; only `owed`, which autopay reads, is held
-- back. Payouts made before the threshold stay as they are and count as paid.
-- Requires 0010. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.ouro_ref_partner_balances WITH (security_invoker = true) AS
  SELECT COALESCE(a.partner, p.partner) AS partner,
         COALESCE(a.accrued, 0) AS accrued,
         COALESCE(p.paid, 0) AS paid,
         CASE WHEN COALESCE(a.fills, 0) >= 3
              THEN COALESCE(a.accrued, 0) - COALESCE(p.paid, 0)
              ELSE 0
         END AS owed
  FROM (SELECT partner, SUM(rebate) AS accrued, COUNT(*) AS fills
        FROM public.ouro_ref_fill_rebates GROUP BY partner) a
  FULL OUTER JOIN (SELECT partner, SUM(amount) AS paid FROM public.ouro_ref_payouts GROUP BY partner) p
    ON p.partner = a.partner;

REVOKE ALL ON public.ouro_ref_partner_balances FROM anon, authenticated;
