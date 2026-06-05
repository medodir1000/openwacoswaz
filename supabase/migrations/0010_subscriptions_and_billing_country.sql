-- ═══════════════════════════════════════════════════════════════════════
-- 0010 — Subscription tiers + per-country billing
--
-- v2 of the SaaS billing model. v1 (migration 0009) introduced the
-- organizations + ai_usage_log + token_packs wallet model. v2 layers
-- subscription tiers on top: customers pay monthly in their LOCAL
-- CURRENCY (MAD for Morocco, XOF for WAEMU, GNF for Guinea, XAF for
-- Central Africa, EGP for Egypt, USD elsewhere) and the
-- organizations.ai_tokens_balance becomes "this period's remaining
-- grant" — it resets on each successful renewal payment.
--
-- Anchor pricing (set in api/brain.py, NOT in the schema, so the
-- operator can tune prices without a migration):
--   Free tier      — 1 session, 50 000 tokens/month
--   Starter $17    — 2 sessions, 500 000 tokens/month
--   Pro $45        — 5 sessions, 1 500 000 tokens/month
--   Business $120  — 15 sessions, 5 000 000 tokens/month
--   Enterprise     — custom
--
-- Token packs (one-time top-ups) from 0009 stay as-is; they fund
-- overage when an org's monthly grant runs out mid-period.
-- ═══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. ORGANIZATIONS — country routing + monthly grant tracking
-- ──────────────────────────────────────────────────────────────────────
alter table public.organizations
  add column if not exists country_code text,
  add column if not exists monthly_token_grant bigint not null default 50000,
  add column if not exists period_starts_at timestamptz default now(),
  add column if not exists period_ends_at   timestamptz default now() + interval '30 days';

create index if not exists organizations_period_ends_idx
  on public.organizations(period_ends_at)
  where period_ends_at is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 2. SUBSCRIPTIONS — one active sub per org, history preserved
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Tier name. Brain reads this to know which monthly_token_grant +
  -- sessions cap to apply. Free tier is the default — orgs without an
  -- active subscription row are treated as Free.
  tier            text not null
                  check (tier in ('free','starter','pro','business','enterprise')),
  -- 'active'    — currently paid + in period
  -- 'past_due'  — renewal hasn't been confirmed yet (CinetPay gap, or
  --                Stripe retrying a failed charge)
  -- 'cancelled' — customer asked to stop; still active until period end
  -- 'expired'   — past-due window exceeded; downgrade to Free
  status          text not null default 'active'
                  check (status in ('active','past_due','cancelled','expired')),
  -- Payment provider routing — Stripe for cards / Morocco / international,
  -- CinetPay for WAEMU (SN/CI/BJ/TG/ML/BF/NE/GW) + Guinea + Central
  -- African Franc countries (CM/GA/CG/TD/CF). 'manual' is admin-managed
  -- cash/bank-transfer subscriptions.
  provider        text not null check (provider in ('stripe','cinetpay','manual')),
  provider_subscription_id text,           -- stripe sub id / cinetpay token / null for manual
  amount_cents    int not null,            -- charged amount in `currency` minor units
  currency        text not null,           -- 'USD','MAD','XOF','GNF','XAF','EGP'
  started_at      timestamptz not null default now(),
  current_period_end timestamptz not null,
  -- 'cancel_at_period_end' lets the customer request a future-dated
  -- cancellation without losing service today.
  cancel_at_period_end boolean not null default false,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists subscriptions_org_idx
  on public.subscriptions(organization_id, started_at desc);

-- At most ONE active subscription per organization. Past subscriptions
-- (cancelled / expired) coexist freely for invoice history.
create unique index if not exists subscriptions_org_active_uniq
  on public.subscriptions(organization_id)
  where status = 'active';

create index if not exists subscriptions_period_idx
  on public.subscriptions(current_period_end)
  where status in ('active','past_due');


-- ──────────────────────────────────────────────────────────────────────
-- 3. RLS — same pattern as 0009: org owner sees own rows, admin sees all
-- ──────────────────────────────────────────────────────────────────────
alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_own on public.subscriptions;
create policy subscriptions_own on public.subscriptions
  for select using (
    organization_id in (
      select id from public.organizations where owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  );

-- Brain writes go through the service_role key which bypasses RLS,
-- so no INSERT/UPDATE policy is needed for the bot path. Customer-
-- facing writes (cancel my subscription button) go through brain too,
-- not directly from the dashboard.
