-- ════════════════════════════════════════════════════════════════════
-- CLOSWIZ — billing schema bundle (migrations 0009 + 0010 + 0011)
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run: every statement is IF NOT EXISTS / guarded.
-- ════════════════════════════════════════════════════════════════════

-- ░░░░░░░░░░ 0009 — organizations + ai_usage_log + token_packs ░░░░░░░░░░
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


-- ░░░░░░░░░░ 0010 — subscriptions + per-country billing ░░░░░░░░░░
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


-- ░░░░░░░░░░ 0011 — manual payment activation ░░░░░░░░░░
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


-- ░░░░░░░░░░ verification — should return 3 rows with counts ░░░░░░░░░░
select 'organizations' as obj, count(*)::text as n from public.organizations
union all select 'subscriptions', count(*)::text from public.subscriptions
union all select 'sellers_linked_to_org', count(*)::text from public.sellers where organization_id is not null;
