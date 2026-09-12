-- ═══════════════════════════════════════════════════════════════════════════
-- referral_codes — the short-link vocabulary, and the reason it needs a table.
--
-- Run once against production, in the SQL editor or via `supabase db push`.
-- Safe to re-run.
--
-- ── Why a table ───────────────────────────────────────────────────────────
--
-- A referral link carried the referrer's address as 42 characters of hex, on a
-- path that already ended in a 42-character project address. A short code
-- cannot be computed from an address: 20 bytes is 160 bits, and a lossless
-- word encoding of 160 bits is fifteen BIP-39 words — longer than the hex it
-- would replace. So the mapping has to be stored, and this is where.
--
-- ── The two constraints that carry the product promise ────────────────────
--
-- `address UNIQUE` is what makes a code PERMANENT. Minting is an upsert keyed
-- on the address: a wallet that asks twice gets the same code back, including
-- from two browsers at the same moment, because the constraint resolves the
-- race in the database rather than in the route. Without it a second mint
-- would issue a second code and every link already pasted somewhere would
-- still work but stop matching what the panel displays — and a referral link
-- is an artifact whose whole job is to keep working after it has left.
--
-- `code PRIMARY KEY` is what makes minting safe to retry. The route generates
-- a random code and inserts; a collision comes back as 23505 and it draws
-- again. The uniqueness is not advisory and is not checked by a SELECT first,
-- which would be a race.
--
-- ── Why RLS and not a public write ────────────────────────────────────────
--
-- Reads are public: resolving a code is what every visitor's first page load
-- does, and the answer — an address that is already on chain — is not secret.
--
-- Writes are the route's alone, same rule as `projects` in 0001, for a
-- different reason. The route is where the code is GENERATED. Let `anon`
-- insert and the code stops being assigned and becomes chosen, which hands
-- anyone `tosh-official-team` pointing at their own wallet — an impersonation
-- surface on the one artifact of this product built to be forwarded by
-- strangers, and one that pays a cut of real deposits. The generator cannot be
-- expressed as a row predicate, so RLS cannot re-derive it; the only way to
-- keep it load-bearing is for the route to be the sole writer.
--
-- Note what is NOT claimed here: minting a code for an address does not prove
-- control of it. It does not need to — a code pointing at someone else's
-- address pays THEM, so there is nothing to gain, and requiring a signature
-- would add a wallet prompt to guard against a favour. Spam is handled by the
-- rate limit on the route.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.referral_codes (
  code       TEXT        PRIMARY KEY,
  address    TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Lowercase-only, so the UNIQUE above actually means one code per wallet.
  -- Addresses arrive from wallets in EIP-55 mixed case, and `0xAbC…` and
  -- `0xabc…` are the same account but two distinct TEXT values — without this
  -- check the constraint would happily hold two codes for one address. The
  -- route lowercases before writing; this makes that a rule rather than a
  -- habit of one call site.
  CONSTRAINT referral_codes_address_lower
    CHECK (address ~ '^0x[0-9a-f]{40}$'),

  -- Three hyphen-separated lowercase words. Shape only, matching
  -- `isRefCodeShape` in `src/lib/refCode.ts`: the word LISTS are deliberately
  -- not encoded here, because growing or reordering them must never
  -- invalidate a code that is already pasted somewhere.
  CONSTRAINT referral_codes_shape
    CHECK (code ~ '^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$')
);

-- `code` and `address` are both already indexed by PRIMARY KEY and UNIQUE, and
-- those are the only two ways this table is ever queried: resolve by code on a
-- visitor's first load, upsert by address when the panel opens. No other index.

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- FORCE also subjects the table owner to these policies, so a later migration
-- or a dashboard action running as `postgres` cannot write around them.
-- `service_role` is unaffected — BYPASSRLS outranks FORCE.
ALTER TABLE public.referral_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referral_codes_public_read ON public.referral_codes;
CREATE POLICY referral_codes_public_read
  ON public.referral_codes
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Deliberately no INSERT, UPDATE or DELETE policy. Under RLS a missing policy
-- denies; this is the rule, not an omission to tidy up later. Adding one for
-- `anon` turns assigned codes into chosen ones — see the header.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.referral_codes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.referral_codes FROM authenticated;
GRANT  SELECT ON public.referral_codes TO anon, authenticated;

COMMENT ON TABLE public.referral_codes IS
  'Short referral codes. One permanent code per wallet, assigned at random by '
  'POST /api/ref and never chosen by the requester; see '
  'supabase/migrations/0004_referral_codes.sql for why RLS cannot express that.';
