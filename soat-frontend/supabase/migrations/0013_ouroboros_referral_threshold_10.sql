-- ═══════════════════════════════════════════════════════════════════════════
-- Raises the payout threshold of 0012 from 3 to 10 filled Agent IDs per
-- partner (all their codes together). Below it a partner is owed nothing;
-- from the tenth fill on, every fill so far is owed, net of what was paid.
-- Payouts already made stand. Requires 0012. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.ouro_ref_partner_balances WITH (security_invoker = true) AS
  SELECT COALESCE(a.partner, p.partner) AS partner,
         COALESCE(a.accrued, 0) AS accrued,
         COALESCE(p.paid, 0) AS paid,
         CASE WHEN COALESCE(a.fills, 0) >= 10
              THEN COALESCE(a.accrued, 0) - COALESCE(p.paid, 0)
              ELSE 0
         END AS owed
  FROM (SELECT partner, SUM(rebate) AS accrued, COUNT(*) AS fills
        FROM public.ouro_ref_fill_rebates GROUP BY partner) a
  FULL OUTER JOIN (SELECT partner, SUM(amount) AS paid FROM public.ouro_ref_payouts GROUP BY partner) p
    ON p.partner = a.partner;

REVOKE ALL ON public.ouro_ref_partner_balances FROM anon, authenticated;
