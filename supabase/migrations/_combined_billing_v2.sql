-- ═══════════════════════════════════════════════════════════════════════
-- CONSOLIDATED BILLING v2 MIGRATION
-- Combines 0009 + 0010 + 0011 into a single paste-and-run block.
--
-- Apply this ONCE in Supabase Studio → SQL Editor → New query →
-- Paste this whole file → Click Run.
--
-- Safe to run multiple times — every statement uses IF NOT EXISTS,
-- DROP POLICY IF EXISTS, etc.
-- ═══════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────
-- PART 1 (from 0009) — organizations table + per-token usage tracking
-- ──────────────────────────────────────────────────────────────────────

create table if not exists public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  owner_user_id       uuid not null references auth.users(id) on delete cascade,
  plan                text not null default 'free'
                          check (plan in ('free','starter','pro','business')),
  ai_tokens_balance   bigint not null default 50000,
  preferred_currency  text not null default 'USD',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists organizations_owner_idx
  on public.organizations(owner_user_id);

alter table public.sellers
  add column if not exists organization_id uuid
    references public.organizations(id) on delete set null;

create index if not exists sellers_organization_idx
  on public.sellers(organization_id);

-- Backfill — one organization per existing seller. Accepts ANY app_user
-- role mapping (originally only 'seller', which silently skipped some
-- sellers — fixed here).
do $$
declare
  s record;
  owner uuid;
  new_org uuid;
begin
  for s in select * from public.sellers where organization_id is null loop
    select au.id into owner from public.app_users au
      where au.seller_id = s.id
      order by au.created_at asc limit 1;
    if owner is null then
      continue;
    end if;
    insert into public.organizations (name, owner_user_id)
    values (s.business_name, owner)
    returning id into new_org;
    update public.sellers set organization_id = new_org where id = s.id;
  end loop;
end $$;


create table if not exists public.ai_usage_log (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  seller_id         uuid references public.sellers(id) on delete set null,
  agent             text not null,
  model             text not null,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  conversation_id   uuid references public.customer_conversations(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists ai_usage_org_day_idx
  on public.ai_usage_log(organization_id, created_at desc);
create index if not exists ai_usage_seller_idx
  on public.ai_usage_log(seller_id, created_at desc);


create table if not exists public.token_packs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  tokens            bigint not null,
  amount_cents      int not null,
  currency          text not null default 'USD',
  stripe_session_id text,
  stripe_payment_intent text,
  status            text not null default 'pending'
                       check (status in ('pending','paid','refunded','failed')),
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index if not exists token_packs_org_idx
  on public.token_packs(organization_id, created_at desc);
create unique index if not exists token_packs_stripe_session_uniq
  on public.token_packs(stripe_session_id)
  where stripe_session_id is not null;


-- AI Agent personalization columns on sellers.
alter table public.sellers
  add column if not exists business_category text
    check (business_category in (
      'e_commerce','restaurant','beauty_salon','real_estate',
      'health_clinic','education','professional_services','other'
    ) or business_category is null);

alter table public.sellers
  add column if not exists tone_of_voice text default 'friendly'
    check (tone_of_voice in ('professional','friendly','persuasive'));

alter table public.sellers
  add column if not exists agent_language text;


-- ──────────────────────────────────────────────────────────────────────
-- PART 2 (from 0010) — subscriptions + per-country billing
-- ──────────────────────────────────────────────────────────────────────

alter table public.organizations
  add column if not exists country_code text,
  add column if not exists monthly_token_grant bigint not null default 50000,
  add column if not exists period_starts_at timestamptz default now(),
  add column if not exists period_ends_at   timestamptz default now() + interval '30 days';

create index if not exists organizations_period_ends_idx
  on public.organizations(period_ends_at)
  where period_ends_at is not null;


create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tier            text not null
                  check (tier in ('free','starter','pro','business','enterprise')),
  status          text not null default 'active'
                  check (status in ('active','past_due','cancelled','expired')),
  provider        text not null check (provider in ('stripe','cinetpay','manual')),
  provider_subscription_id text,
  amount_cents    int not null,
  currency        text not null,
  started_at      timestamptz not null default now(),
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists subscriptions_org_idx
  on public.subscriptions(organization_id, started_at desc);

create unique index if not exists subscriptions_org_active_uniq
  on public.subscriptions(organization_id)
  where status = 'active';

create index if not exists subscriptions_period_idx
  on public.subscriptions(current_period_end)
  where status in ('active','past_due');


-- ──────────────────────────────────────────────────────────────────────
-- PART 3 (from 0011) — manual payment activation
-- ──────────────────────────────────────────────────────────────────────

alter table public.subscriptions
  add column if not exists months_paid_for int not null default 1
    check (months_paid_for between 1 and 12),
  add column if not exists payment_method text,
  add column if not exists payment_proof_url text,
  add column if not exists payment_reference text,
  add column if not exists admin_notes text,
  add column if not exists activated_by_user_id uuid references auth.users(id),
  add column if not exists activated_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text;

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
      'pending_admin_review','active','past_due','cancelled','expired','rejected'
    ));

create index if not exists subscriptions_pending_review_idx
  on public.subscriptions(created_at desc)
  where status = 'pending_admin_review';


-- ──────────────────────────────────────────────────────────────────────
-- PART 4 — RLS policies (organizations + ai_usage_log + token_packs + subscriptions)
-- ──────────────────────────────────────────────────────────────────────

alter table public.organizations enable row level security;
drop policy if exists organizations_own on public.organizations;
create policy organizations_own on public.organizations
  for all using (
    owner_user_id = auth.uid()
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  ) with check (
    owner_user_id = auth.uid()
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  );

alter table public.ai_usage_log enable row level security;
drop policy if exists ai_usage_own on public.ai_usage_log;
create policy ai_usage_own on public.ai_usage_log
  for select using (
    organization_id in (
      select id from public.organizations where owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  );

alter table public.token_packs enable row level security;
drop policy if exists token_packs_own on public.token_packs;
create policy token_packs_own on public.token_packs
  for select using (
    organization_id in (
      select id from public.organizations where owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  );

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

-- Done. After running this, verify in Supabase Studio:
--   ✓ Table organizations exists and has 1 row per seller
--   ✓ Table ai_usage_log exists (empty for now)
--   ✓ Table token_packs exists (empty for now)
--   ✓ Table subscriptions exists (empty for now)
--   ✓ sellers.organization_id column is filled for every seller
