-- ═══════════════════════════════════════════════════════════════════════════
-- Partner invite applications: anyone may apply; a Safe signer approves.
-- Approved rows become `ouro_ref_links` (+ season bonus). Requires 0010.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ouro_ref_applications (
  id            BIGSERIAL   PRIMARY KEY,
  code          TEXT        NOT NULL CHECK (code ~ '^[a-z0-9]{3,16}$'),
  partner       TEXT        NOT NULL CHECK (partner ~ '^0x[0-9a-f]{40}$'),
  label         TEXT        NOT NULL DEFAULT '' CHECK (length(label) <= 64),
  status        TEXT        NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   TEXT,
  reject_reason TEXT        CHECK (reject_reason IS NULL OR length(reject_reason) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS ouro_ref_applications_pending_partner
  ON public.ouro_ref_applications (partner) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS ouro_ref_applications_open_code
  ON public.ouro_ref_applications (code) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS ouro_ref_applications_status_applied
  ON public.ouro_ref_applications (status, applied_at DESC);

ALTER TABLE public.ouro_ref_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ouro_ref_applications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ouro_ref_applications FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ouro_ref_applications_id_seq FROM anon, authenticated;
