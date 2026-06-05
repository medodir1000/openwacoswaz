-- ============================================================
-- CATCH-UP: brings psnrabnwlqqlwezjfunp from ~0004 to current.
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Paste the WHOLE file into Supabase Studio → SQL Editor → Run.
-- ============================================================

-- ╔══════════════════════════════════════════════════════════
-- ║ 0006_product_session_routing.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- Per-product WhatsApp session routing
--
-- A seller can pin a product to one or more of their WhatsApp sessions
-- (e.g. "bot12 → BioRein"). When a customer messages that number, the
-- bot uses the pinned product as the default conversation context.
--
-- Empty array (the default for existing rows) preserves today's
-- behavior: the bot keyword-matches across the seller's whole catalog.
-- Non-empty array means "this product is the default when a customer
-- writes to one of these numbers" — keyword detection in the message
-- can still override the default (smart routing in brain.py).
-- ═══════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists whatsapp_session_ids text[] not null default '{}';

-- GIN index for the typical lookup pattern in brain.py:
--   "give me products where whatsapp_session_ids contains <session_id>"
-- Runs in O(matches) regardless of catalog size.
create index if not exists products_wa_sessions_gin
  on public.products using gin (whatsapp_session_ids);

-- ╔══════════════════════════════════════════════════════════
-- ║ 0007_product_gallery.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- Per-product image gallery
--
-- products.image_url is the single "card" image shown in the dashboard.
-- gallery_urls is an additional ordered list of supplementary images the
-- seller wants the bot to send to the customer (e.g. multiple angles,
-- benefit infographics, testimonials, ingredient lists).
--
-- The bot sends gallery images opportunistically — once per conversation,
-- right after the product is first detected — so the customer sees the
-- visuals before the price reveal. Empty array = no extra images, bot
-- stays text-only (unchanged behavior for sellers who don't use this).
-- ═══════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists gallery_urls text[] not null default '{}';

-- ╔══════════════════════════════════════════════════════════
-- ║ 0008_product_kind.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 0008 — Service-kind support.
--
-- Until now every row in `products` was treated as a physical e-commerce
-- good (the bot collects name, city, address, quantity → push to sheet).
-- Sellers who run services — rental cars, haircuts, plumbing visits,
-- catering, appointments — need a different conversation flow:
--   name → service_date → city → address → notes → confirm
--
-- Adding a `kind` column lets sellers tag each "product" as either
-- 'product' or 'service', and the brain's stage machine + system prompt
-- branch on it. Existing rows default to 'product' so nothing breaks.
--
-- The check constraint is intentionally small (just two values) so we
-- can iterate quickly. A future migration can extend it to include
-- 'rental', 'subscription', etc. once we have customer feedback.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists kind text not null default 'product'
    check (kind in ('product', 'service'));

-- Most queries filter by seller_id first, then occasionally narrow on
-- kind in the funnel UI. A small partial index keeps service lookups
-- fast without bloating the index on the predominantly-product table.
create index if not exists products_kind_service_idx
  on public.products(seller_id)
  where kind = 'service';

-- ╔══════════════════════════════════════════════════════════
-- ║ 0009_organizations_and_billing.sql
-- ╚══════════════════════════════════════════════════════════

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

-- ╔══════════════════════════════════════════════════════════
-- ║ 0010_subscriptions_and_billing_country.sql
-- ╚══════════════════════════════════════════════════════════

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

-- ╔══════════════════════════════════════════════════════════
-- ║ 0011_manual_payment_activation.sql
-- ╚══════════════════════════════════════════════════════════

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

-- ╔══════════════════════════════════════════════════════════
-- ║ 0012_product_custom_fields.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 0012 — Universal "Any Service" custom fields.
--
-- Migration 0008 gave each product a `kind` ('product' | 'service') so the
-- bot could branch its conversation flow. Services still collected a FIXED
-- set of fields though (name → service_date → city → address → notes),
-- which doesn't fit every business: a car-rental needs "type de voiture",
-- a clinic needs "motif de consultation", a salon needs "prestation
-- souhaitée". Hard-coding every variation is impossible.
--
-- `custom_fields` makes the extraction schema 100 % seller-defined. Each
-- service row carries an ordered JSON array describing exactly what the AI
-- must extract from the customer before an order/booking is considered
-- complete. The brain reads this array to (a) generate the system prompt's
-- "fields to collect" block dynamically and (b) gate confirmation until
-- every required field is filled. The dashboard's ProductDrawer renders an
-- editor for it.
--
-- Shape — array of field-definition objects:
--   [
--     { "key": "name",          "label": "Nom complet",
--       "type": "text",  "required": true,  "is_standard": true  },
--     { "key": "service_date",  "label": "Date de réservation",
--       "type": "date",  "required": true,  "is_standard": false },
--     { "key": "car_type",      "label": "Type de voiture",
--       "type": "text",  "required": false, "is_standard": false }
--   ]
--
--   key         — stable snake_case identifier; also the key the bot writes
--                 into customer_conversations.pending_order_fields and the
--                 LLM's extracted_order_fields. Must be unique within a row.
--   label       — human label shown to the seller + used in the prompt so
--                 the AI knows what it's asking for ("Date de réservation").
--   type        — one of text | phone | number | date | choice. Drives the
--                 hint the brain gives the LLM (parse a date, a count, …).
--   required    — when true the bot must collect it before confirming.
--   is_standard — true for the built-in name/phone toggles, false for
--                 fields the seller typed themselves. Purely cosmetic on
--                 the brain side; the dashboard uses it to render toggles
--                 vs. removable custom rows.
--
-- Empty array '[]' (the default + every existing/product row) means "no
-- custom schema" → the brain keeps its previous hard-coded behaviour, so
-- nothing breaks for sellers who never touch this.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists custom_fields jsonb not null default '[]'::jsonb;

-- Guard against a non-array value sneaking in (the brain + dashboard both
-- assume a top-level JSON array). A NULL is impossible (NOT NULL default),
-- but a stray object/string would break iteration — reject it at write time.
alter table public.products
  drop constraint if exists products_custom_fields_is_array;
alter table public.products
  add constraint products_custom_fields_is_array
    check (jsonb_typeof(custom_fields) = 'array');

-- ╔══════════════════════════════════════════════════════════
-- ║ 0013_business_category_verticals.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 0013 — Widen sellers.business_category for the dynamic multi-service UI.
--
-- Migration 0009 introduced `business_category` with eight values so the
-- brain could tailor its data-collection script per vertical. The dashboard
-- now ALSO reads this column to re-skin itself end-to-end — page titles,
-- table columns, stat labels, the live-activity feed and terminology all
-- adapt to the seller's domain (an e-commerce seller sees "Orders /
-- Products / Customers"; a clinic sees "Consultations / Services /
-- Patients"; a car-rental sees "Reservations / Vehicles / Clients").
--
-- Three high-demand African-market verticals were missing from the original
-- CHECK set and are added here:
--   • car_rental    — booking flow: vehicle type → pick-up/return dates → days
--   • hotel         — booking flow: room type → check-in/out → guests → nights
--   • travel_agency — package flow: destination → dates → travelers
--
-- The other spec verticals need no new DB value — the dashboard maps them
-- onto existing categories at render time:
--   • "freelance" → professional_services
--   • "custom"    → other
--
-- This migration is a pure constraint-widening: every existing row stays
-- valid (the eight original values are preserved), and `NULL` still means
-- "unset → treated as e-commerce", so nothing breaks for current sellers.
-- ═══════════════════════════════════════════════════════════════════════

-- The 0009 inline check was created unnamed (Postgres auto-named it
-- `sellers_business_category_check`). Drop whatever is there, then add a
-- single explicitly-named constraint we can manage in future migrations.
alter table public.sellers
  drop constraint if exists sellers_business_category_check;

-- Some PG versions name an inline column-check after the column instead;
-- drop that spelling too so this migration is safe to re-run.
alter table public.sellers
  drop constraint if exists business_category_check;

alter table public.sellers
  add constraint sellers_business_category_check
    check (
      business_category in (
        'e_commerce','restaurant','beauty_salon','real_estate',
        'health_clinic','education','professional_services','other',
        'car_rental','hotel','travel_agency'
      )
      or business_category is null
    );

-- ── Verify (run by hand in the SQL editor) ──────────────────────────────
--   -- should succeed:
--   update public.sellers set business_category = 'car_rental'
--     where id = '<some-seller-id>';
--   -- should fail with a constraint violation:
--   update public.sellers set business_category = 'not_a_vertical'
--     where id = '<some-seller-id>';

-- ╔══════════════════════════════════════════════════════════
-- ║ 0013_seller_free_trial.sql
-- ╚══════════════════════════════════════════════════════════

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

-- ╔══════════════════════════════════════════════════════════
-- ║ 0014_shopify_integrations.sql
-- ╚══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 0014 — Shopify → Konvico order integration (Custom App token method)
--
-- Any seller can connect their own Shopify store so orders flow
-- automatically into Konvico. The seller creates a *Custom App* in their
-- Shopify admin (Settings → Apps and sales channels → Develop apps),
-- grants the `read_orders` scope, and pastes three secrets into Konvico:
--
--   • shop_domain   — e.g. "my-store.myshopify.com"
--   • access_token  — the Admin API access token (starts "shpat_…")
--   • api_secret    — the app's API secret key (used to sign webhooks)
--
-- On connect, the brain verifies the credentials against the Shopify
-- Admin API and registers an `orders/create` webhook pointing back at
-- `${PUBLIC_BASE_URL}/funnel/integrations/shopify/webhook`. Every webhook
-- delivery is authenticated with HMAC-SHA256 (the `X-Shopify-Hmac-Sha256`
-- header) against the stored `api_secret`, and the originating store is
-- identified by the `X-Shopify-Shop-Domain` header. A valid delivery is
-- mapped onto a Konvico `orders` row with status='pending' (NO automatic
-- WhatsApp message — the seller stays in control).
--
-- All additions are non-destructive. The brain reads the new columns with
-- the same defensive fallback-select pattern used since migration 0006,
-- so the bot keeps working before this migration is applied.
-- ═══════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. SHOPIFY_INTEGRATIONS — one connected store per seller
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.shopify_integrations (
  id                  uuid primary key default gen_random_uuid(),
  seller_id           uuid not null
                        references public.sellers(id) on delete cascade,
  -- The .myshopify.com domain. Unique platform-wide: a single Shopify
  -- store can only feed one Konvico seller (prevents webhook ambiguity —
  -- we resolve the seller from the X-Shopify-Shop-Domain header).
  shop_domain         text not null,
  -- Admin API access token ("shpat_…"). Stored so the brain can register
  -- /delete webhooks and read order details. Secret — never returned to
  -- the dashboard un-masked.
  access_token        text not null,
  -- API secret key — the signing key Shopify uses for webhook HMACs.
  -- Secret — never returned to the dashboard un-masked.
  api_secret          text not null,
  -- Shopify's id for the registered orders/create webhook, so we can
  -- delete it on disconnect. Null when registration was deferred (e.g.
  -- PUBLIC_BASE_URL not yet public in dev).
  webhook_id          text,
  -- Admin API version the webhook was registered against (e.g. "2024-10")
  -- so a future API bump can detect + re-register stale webhooks.
  webhook_api_version text,
  status              text not null default 'connected'
                        check (status in ('connected','error','disconnected')),
  -- Operational telemetry surfaced on the Integrations page.
  last_order_at       timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One integration row per seller (upsert target) …
create unique index if not exists shopify_integrations_seller_uniq
  on public.shopify_integrations(seller_id);
-- … and one Konvico seller per Shopify store (webhook → seller resolution).
create unique index if not exists shopify_integrations_shop_uniq
  on public.shopify_integrations(lower(shop_domain));

create trigger trg_shopify_integrations_updated
  before update on public.shopify_integrations
  for each row execute function public.touch_updated_at();


-- ──────────────────────────────────────────────────────────────────────
-- 2. ORDERS — provenance + Shopify idempotency
-- ──────────────────────────────────────────────────────────────────────
-- Where this order came from. Existing rows are all WhatsApp-funnel
-- orders, so the default keeps them correct; Shopify imports write
-- 'shopify'. A future "manual" / "api" source slots in here too.
alter table public.orders
  add column if not exists source text not null default 'whatsapp';

-- Shopify's order id (numeric, stored as text). Lets us dedupe webhook
-- re-deliveries — Shopify retries on any non-2xx and may fire the same
-- orders/create twice. Null for native WhatsApp orders.
alter table public.orders
  add column if not exists shopify_order_id text;

-- Idempotency backstop: a given Shopify order imports at most once per
-- seller. Partial so the millions of WhatsApp orders (shopify_order_id
-- null) don't collide on a single null value.
create unique index if not exists orders_seller_shopify_uniq
  on public.orders(seller_id, shopify_order_id)
  where shopify_order_id is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 3. PRODUCTS — Shopify product mapping
-- ──────────────────────────────────────────────────────────────────────
-- When an imported order's line item references a Shopify product we
-- haven't seen, the brain match-or-creates a Konvico product and stamps
-- the Shopify product id here so the next order for the same item reuses
-- the existing Konvico product instead of creating a duplicate.
alter table public.products
  add column if not exists shopify_product_id text;

create index if not exists products_seller_shopify_idx
  on public.products(seller_id, shopify_product_id)
  where shopify_product_id is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 4. RLS — tenant-scoped reads (defense in depth)
-- ──────────────────────────────────────────────────────────────────────
-- The brain talks to Supabase with the service_role key, which bypasses
-- RLS, so the connect/disconnect/webhook writes aren't gated by these
-- policies. The dashboard reads integration status THROUGH the brain
-- (masked), never directly — but we still scope the table the same way
-- as every other tenant table so a future direct read can't leak another
-- seller's store credentials.
alter table public.shopify_integrations enable row level security;
drop policy if exists shopify_integrations_own on public.shopify_integrations;
create policy shopify_integrations_own on public.shopify_integrations
  for all using (
    seller_id in (
      select seller_id from public.app_users where id = auth.uid()
    )
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  ) with check (
    seller_id in (
      select seller_id from public.app_users where id = auth.uid()
    )
    or exists (
      select 1 from public.app_users
      where id = auth.uid() and role = 'admin'
    )
  );

-- ╔══════════════════════════════════════════════════════════
-- ║ Activate the 2-day / 30-conversation trial for the current seller
-- ╚══════════════════════════════════════════════════════════
update public.sellers
set is_trial = true,
    trial_started_at = now(),
    trial_ends_at    = now() + interval '2 days',
    trial_conversations_cap = 30
where id = '95ae7c8a-62c1-4552-b2b9-19bb8363dd3e';
