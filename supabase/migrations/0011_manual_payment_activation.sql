-- ═══════════════════════════════════════════════════════════════════════
-- 0011 — Manual payment activation (admin-driven subscription lifecycle)
--
-- Walking back the auto-pay flow added in 0010. Reality on the ground:
--
--   • Morocco          → seller pays by bank transfer (versement tijari)
--                         or CIH branch deposit
--   • WAEMU / Guinea / → seller pays by Orange Money / MTN MoMo / Wave
--     CEMAC               to the operator's mobile-money number
--
-- Neither Stripe nor CinetPay fits cleanly — bank transfers in Morocco
-- arrive without a transaction ID we can match programmatically, and
-- the WAEMU/Guinea operators don't all offer SaaS-friendly APIs to a
-- new merchant on day one. So the customer flow becomes:
--
--   1. Customer chooses tier + months on /billing
--   2. Dashboard shows a modal with payment instructions (bank RIB
--      for MA, Orange Money number for WAEMU/GN, etc.) + a fixed
--      reference code so the admin can match the deposit.
--   3. Customer submits the request → subscriptions row is inserted
--      with status='pending_admin_review' + months_paid_for + proof_url.
--   4. Admin reviews the request on a new /admin/subscriptions page,
--      sees the proof, clicks "Activate for X months" → row flips
--      to status='active', period_ends_at = now() + X·30 days, and the
--      organization's ai_tokens_balance is refilled to
--      monthly_token_grant × X (one big grant to cover the whole
--      multi-month period without daily resets).
-- ═══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. SUBSCRIPTIONS — extend with manual-payment metadata
-- ──────────────────────────────────────────────────────────────────────
alter table public.subscriptions
  -- How many months the customer asked to be billed for (and that the
  -- admin will eventually grant). Default 1 = month-to-month.
  add column if not exists months_paid_for int not null default 1
    check (months_paid_for between 1 and 12),
  -- 'bank_transfer' (Morocco) | 'orange_money' (WAEMU/Guinea/CEMAC)
  --  | 'mtn_momo' | 'wave' | 'cih_deposit' | 'other'
  add column if not exists payment_method text,
  -- Customer-uploaded screenshot / PDF URL — Supabase Storage path.
  -- Optional; some sellers send the proof via WhatsApp instead.
  add column if not exists payment_proof_url text,
  -- Free-text reference the customer cites when transferring (so the
  -- admin can match the bank statement line to this subscription row).
  -- Generated server-side as a short, unique-per-org code.
  add column if not exists payment_reference text,
  -- Admin's note when activating or rejecting ("reçu 350 MAD au lieu
  -- de 170, accordé 2 mois au prorata").
  add column if not exists admin_notes text,
  -- Who activated it + when, for audit trail.
  add column if not exists activated_by_user_id uuid references auth.users(id),
  add column if not exists activated_at timestamptz,
  -- For rejected requests — captures why.
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text;

-- Drop + recreate the status CHECK so 'pending_admin_review' is allowed.
-- Wrapped in DO block so re-running this migration doesn't fail.
do $$
begin
  if exists (select 1 from pg_constraint
             where conname = 'subscriptions_status_check') then
    alter table public.subscriptions drop constraint subscriptions_status_check;
  end if;
end $$;

alter table public.subscriptions
  add constraint subscriptions_status_check
    check (status in (
      'pending_admin_review',
      'active',
      'past_due',
      'cancelled',
      'expired',
      'rejected'
    ));

-- The unique-active-per-org index from 0010 still applies — only one
-- 'active' sub per org. Multiple 'pending_admin_review' rows can
-- coexist (customer might re-submit before the first is reviewed),
-- but the activation flow rejects duplicates server-side.
create index if not exists subscriptions_pending_review_idx
  on public.subscriptions(created_at desc)
  where status = 'pending_admin_review';


-- ──────────────────────────────────────────────────────────────────────
-- 2. RLS — admin can SELECT all pending rows (for the review queue)
-- ──────────────────────────────────────────────────────────────────────
-- The select policy from 0010 already lets admin see everything via the
-- `role='admin'` branch, so no new policy needed here. Documenting:
--
--   SELECT: owner OR admin (from 0010 policy `subscriptions_own`)
--   INSERT/UPDATE: service_role only (brain handles all writes)
