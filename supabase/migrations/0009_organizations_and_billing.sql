-- ═══════════════════════════════════════════════════════════════════════
-- 0009 — Organizations + per-token billing + AI Agent personalization
--
-- Three orthogonal additions, all SaaS polish:
--
--   1. `organizations` — the new tenancy unit one level above `sellers`.
--      Today every seller is its own one-org tenant (backfilled below);
--      tomorrow the same buyer can own multiple sellers (multi-store
--      under one billing account).
--
--   2. AI usage tracking — `ai_usage_log` captures token counts per LLM
--      call (already in OpenRouter responses, currently discarded). The
--      running balance lives on `organizations.ai_tokens_balance` and
--      decrements as Agent 1 + Agent 2 fire. `token_packs` records
--      Stripe top-up purchases. Together they enable the "247k Tokens
--      IA" counter in the top bar + the Billing page.
--
--   3. AI Agent personalization — three new columns on `sellers` so the
--      AI Agent Wizard can persist what kind of business they run
--      (e_commerce / restaurant / beauty_salon / real_estate /
--      health_clinic / education / professional_services / other), the
--      tone of voice (professional / friendly / persuasive), and the
--      agent language. `brain.build_system_prompt()` reads these and
--      adapts the persona block.
--
-- All additions are non-destructive. Brain reads each new column with
-- the same defensive fallback-select pattern used for migrations
-- 0006/0007/0008, so the bot keeps working before this migration is
-- applied.
-- ═══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. ORGANIZATIONS — the new tenancy root
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  owner_user_id       uuid not null references auth.users(id) on delete cascade,
  plan                text not null default 'free'
                          check (plan in ('free','starter','pro','business')),
  -- AI token wallet. Seed grant of 50k tokens for new orgs = roughly
  -- 80-120 customer conversations on gpt-4o-mini + gpt-5.1-chat mix,
  -- enough to experience the bot before topping up.
  ai_tokens_balance   bigint not null default 50000,
  -- Display currency for the top-bar amount formatter (e.g. order
  -- totals get reformatted to USD even if the seller priced in MAD).
  -- Per-product prices stay in their native currency on the orders
  -- table; this is purely a display preference.
  preferred_currency  text not null default 'USD',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists organizations_owner_idx
  on public.organizations(owner_user_id);

-- Link sellers to organizations. Nullable for the brief window between
-- this migration and the backfill below.
alter table public.sellers
  add column if not exists organization_id uuid
    references public.organizations(id) on delete set null;

create index if not exists sellers_organization_idx
  on public.sellers(organization_id);

-- Backfill: one organization per existing seller, owned by whichever
-- user is already mapped in app_users. Idempotent — running this
-- migration twice produces no extra rows.
do $$
declare
  s record;
  owner uuid;
  new_org uuid;
begin
  for s in select * from public.sellers where organization_id is null loop
    select au.id into owner from public.app_users au
      where au.seller_id = s.id and au.role = 'seller'
      order by au.created_at asc limit 1;
    if owner is null then
      -- Seller has no app_user yet (rare — signup half-completed).
      -- Skip; the next signup attempt will fix it.
      continue;
    end if;
    insert into public.organizations (name, owner_user_id)
    values (s.business_name, owner)
    returning id into new_org;
    update public.sellers set organization_id = new_org where id = s.id;
  end loop;
end $$;


-- ──────────────────────────────────────────────────────────────────────
-- 2. AI USAGE LOG — captured on every LLM call
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.ai_usage_log (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  seller_id         uuid references public.sellers(id) on delete set null,
  -- 'agent1' (orchestrator) | 'agent2' (communicator) | 'closer' (future)
  agent             text not null,
  model             text not null,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  -- Reference back to the conversation that triggered this call so the
  -- seller can see which customer "cost" how many tokens. Nullable for
  -- internal/admin calls that don't tie to a customer chat.
  conversation_id   uuid references public.customer_conversations(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists ai_usage_org_day_idx
  on public.ai_usage_log(organization_id, created_at desc);
create index if not exists ai_usage_seller_idx
  on public.ai_usage_log(seller_id, created_at desc);


-- ──────────────────────────────────────────────────────────────────────
-- 3. TOKEN PACKS — Stripe purchases
-- ──────────────────────────────────────────────────────────────────────
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


-- ──────────────────────────────────────────────────────────────────────
-- 4. SELLERS — AI Agent personalization columns
-- ──────────────────────────────────────────────────────────────────────
-- business_category drives category-specific persona guidance in
-- brain.build_system_prompt() (e.g. restaurants collect dish/time
-- instead of city/quantity).
alter table public.sellers
  add column if not exists business_category text
    check (business_category in (
      'e_commerce','restaurant','beauty_salon','real_estate',
      'health_clinic','education','professional_services','other'
    ) or business_category is null);

-- tone_of_voice nudges the LLM's persona warmth/formality.
alter table public.sellers
  add column if not exists tone_of_voice text default 'friendly'
    check (tone_of_voice in ('professional','friendly','persuasive'));

-- agent_language seed for the conversation language. Once a chat is
-- pinned via stored_language it overrides this — but new chats with
-- no signal from the customer bootstrap from here.
alter table public.sellers
  add column if not exists agent_language text;


-- ──────────────────────────────────────────────────────────────────────
-- 5. RLS for the new tables
-- ──────────────────────────────────────────────────────────────────────
-- organizations: a user can read/update orgs they own; admin sees all.
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

-- ai_usage_log: a user reads usage rows for orgs they own.
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

-- token_packs: same as usage — readable by the org owner + admin.
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

-- The brain uses the service_role key, which bypasses RLS — so the
-- inserts into ai_usage_log + balance updates from process_inbound_message
-- aren't blocked by these policies. Only the dashboard's user-scoped
-- reads are gated.
