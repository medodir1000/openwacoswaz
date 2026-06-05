-- ============================================================================
-- 0013_seller_free_trial.sql
-- Free trial for self-serve signups.
--
-- A brand-new seller who signs up through the landing page gets INSTANT
-- access (no waiting for manual admin approval) for a short window so they
-- can try the bot before paying. Whichever limit hits first ends the trial:
--   • TRIAL_DAYS elapsed (default 2 days), OR
--   • TRIAL_CONVERSATIONS_CAP distinct customer conversations (default 30).
--
-- Once the trial closes and the seller has no active paid subscription, the
-- bot stays silent until they subscribe (enforced in api/brain.py via
-- _trial_allows_reply). The remaining trial is surfaced on the dashboard
-- Billing page.
--
-- Every column is additive + nullable or defaulted, so the brain keeps
-- working whether or not this migration has been applied — it probes these
-- columns defensively and degrades to "no trial cap" (safe) when absent.
-- ============================================================================

alter table public.sellers
  add column if not exists is_trial                 boolean not null default false,
  add column if not exists trial_started_at         timestamptz,
  add column if not exists trial_ends_at            timestamptz,
  add column if not exists trial_conversations_cap  integer not null default 30;

comment on column public.sellers.is_trial is
  'True while the seller is on the free trial (no active paid subscription yet). Cleared when they subscribe.';
comment on column public.sellers.trial_ends_at is
  'When the free trial expires. After this — or once trial_conversations_cap distinct conversations are reached — the bot goes silent until the seller subscribes.';
comment on column public.sellers.trial_conversations_cap is
  'Maximum distinct customer conversations allowed during the free trial.';

-- Fast counting of trial conversations started since trial_started_at.
-- Guarded so the migration still succeeds if customer_conversations.created_at
-- is named differently on an older schema.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'customer_conversations'
      and column_name  = 'created_at'
  ) then
    create index if not exists customer_conversations_seller_created_idx
      on public.customer_conversations (seller_id, created_at);
  end if;
end $$;
