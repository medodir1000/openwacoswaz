-- ═══════════════════════════════════════════════════════════════════════
-- leadecombot — multi-tenant WhatsApp SaaS schema
--
-- Tenancy model: every domain table has `seller_id`. RLS policies scope
-- visibility to the seller_id linked through `app_users` to auth.uid().
-- The brain (Flask) uses the service_role JWT to bypass RLS for inserts
-- coming from the bot. The admin UI uses the anon key and gets RLS-filtered
-- rows automatically.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. SELLERS (tenants) ───────────────────────────────────────────────
create table if not exists public.sellers (
  id                  uuid primary key default gen_random_uuid(),
  business_name       text not null,
  business_email      text not null unique,
  -- ISO 3166-1 alpha-2 codes the seller ships to. Drives bot country logic.
  country_codes       text[] not null default '{}',
  default_language    text not null default 'en',
  bot_persona         text not null default 'You are a friendly sales assistant for {{business_name}}.',
  sheets_webhook_url  text,
  openrouter_model    text default 'openai/gpt-4o-mini',
  daily_msg_cap       int not null default 200,
  status              text not null default 'active'
                          check (status in ('active','paused','disabled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ── 2. AUTH MAPPING (auth.user → seller_id + role) ─────────────────────
create table if not exists public.app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  seller_id   uuid references public.sellers(id) on delete cascade,
  role        text not null default 'seller'
                  check (role in ('admin','seller')),
  created_at  timestamptz not null default now()
);

create index if not exists app_users_seller_id_idx on public.app_users(seller_id);

-- ── 3. WHATSAPP SESSIONS (one per seller) ──────────────────────────────
create table if not exists public.seller_whatsapp_sessions (
  id            uuid primary key default gen_random_uuid(),
  seller_id     uuid not null references public.sellers(id) on delete cascade,
  phone         text not null,
  jid           text,
  status        text not null default 'pending'
                    check (status in ('pending','connected','disconnected','expired')),
  paired_at     timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique(seller_id, phone)
);

create index if not exists wa_sessions_seller_idx on public.seller_whatsapp_sessions(seller_id);

-- ── 4. PRODUCTS + per-country pricing ──────────────────────────────────
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  seller_id     uuid not null references public.sellers(id) on delete cascade,
  name          text not null,
  description   text,
  image_url     text,
  -- Free-text hints for the LLM product-detection step (synonyms, common
  -- misspellings, brand names).
  aliases       text[] default '{}',
  status        text not null default 'active'
                    check (status in ('active','out_of_stock','archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists products_seller_idx on public.products(seller_id, status);

create table if not exists public.product_countries (
  id                       uuid primary key default gen_random_uuid(),
  product_id               uuid not null references public.products(id) on delete cascade,
  -- ISO 3166-1 alpha-2 (e.g. 'MA', 'FR', 'SA').
  country_code             text not null,
  -- ISO 639-1 (e.g. 'ar', 'fr', 'en').
  language_code            text not null,
  price                    numeric(12,2) not null,
  currency                 text not null,         -- ISO 4217 ('MAD','EUR','USD'...)
  translated_name          text,
  translated_description   text,
  available                boolean not null default true,
  created_at               timestamptz not null default now(),
  unique(product_id, country_code)
);

create index if not exists product_countries_product_idx on public.product_countries(product_id);

-- ── 5. CUSTOMER CONVERSATIONS ──────────────────────────────────────────
create table if not exists public.customer_conversations (
  id                    uuid primary key default gen_random_uuid(),
  seller_id             uuid not null references public.sellers(id) on delete cascade,
  customer_jid          text not null,
  customer_phone        text,
  country_code          text,
  language_code         text,
  detected_product_id   uuid references public.products(id) on delete set null,
  status                text not null default 'active'
                            check (status in ('active','order_placed','abandoned','blocked')),
  started_at            timestamptz not null default now(),
  last_message_at       timestamptz not null default now(),
  unique(seller_id, customer_jid)
);

create index if not exists conversations_seller_idx on public.customer_conversations(seller_id, status);
create index if not exists conversations_last_msg_idx on public.customer_conversations(seller_id, last_message_at desc);

-- ── 6. MESSAGES (conversation history for the LLM) ─────────────────────
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.customer_conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conv_idx on public.messages(conversation_id, created_at);

-- ── 7. ORDERS (mirror of what gets POSTed to seller's Sheets) ──────────
create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  seller_id           uuid not null references public.sellers(id) on delete cascade,
  conversation_id     uuid references public.customer_conversations(id) on delete set null,
  product_id          uuid not null references public.products(id) on delete restrict,
  customer_jid        text not null,
  customer_name       text,
  customer_phone      text,
  customer_address    text,
  customer_city       text,
  quantity            int not null default 1 check (quantity > 0),
  unit_price          numeric(12,2) not null,
  total_price         numeric(12,2) not null,
  currency            text not null,
  country_code        text,
  status              text not null default 'pending'
                          check (status in ('pending','confirmed','dispatched','delivered','cancelled')),
  sheets_sync_status  text not null default 'pending'
                          check (sheets_sync_status in ('pending','synced','failed')),
  sheets_sync_at      timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists orders_seller_idx on public.orders(seller_id, status, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════
-- Helpers + RLS policies
-- ═══════════════════════════════════════════════════════════════════════

-- Lookup the seller_id of the currently-logged-in admin/seller user.
create or replace function public.current_seller_id()
  returns uuid
  language sql
  security definer
  set search_path = public
as $$
  select seller_id from public.app_users where id = auth.uid()
$$;

-- True if the logged-in user is the platform admin (cross-tenant access).
create or replace function public.current_is_admin()
  returns boolean
  language sql
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where id = auth.uid() and role = 'admin'
  )
$$;

-- Enable RLS on every tenant table.
alter table public.sellers                    enable row level security;
alter table public.app_users                  enable row level security;
alter table public.seller_whatsapp_sessions   enable row level security;
alter table public.products                   enable row level security;
alter table public.product_countries          enable row level security;
alter table public.customer_conversations     enable row level security;
alter table public.messages                   enable row level security;
alter table public.orders                     enable row level security;

-- ── Policies: sellers see their own row, admins see all ───────────────
drop policy if exists "sellers_own_row" on public.sellers;
create policy "sellers_own_row" on public.sellers
  for all to authenticated
  using (id = public.current_seller_id() or public.current_is_admin())
  with check (id = public.current_seller_id() or public.current_is_admin());

drop policy if exists "app_users_own_row" on public.app_users;
create policy "app_users_own_row" on public.app_users
  for all to authenticated
  using (id = auth.uid() or public.current_is_admin())
  with check (id = auth.uid() or public.current_is_admin());

-- ── Tenant-scoped policy template (applied to remaining 6 tables) ─────
-- (Single helper since the predicate is identical.)

-- seller_whatsapp_sessions
drop policy if exists "wa_sessions_tenant" on public.seller_whatsapp_sessions;
create policy "wa_sessions_tenant" on public.seller_whatsapp_sessions
  for all to authenticated
  using (seller_id = public.current_seller_id() or public.current_is_admin())
  with check (seller_id = public.current_seller_id() or public.current_is_admin());

-- products
drop policy if exists "products_tenant" on public.products;
create policy "products_tenant" on public.products
  for all to authenticated
  using (seller_id = public.current_seller_id() or public.current_is_admin())
  with check (seller_id = public.current_seller_id() or public.current_is_admin());

-- product_countries — scoped via the parent product's seller_id.
drop policy if exists "product_countries_tenant" on public.product_countries;
create policy "product_countries_tenant" on public.product_countries
  for all to authenticated
  using (
    public.current_is_admin() or exists (
      select 1 from public.products p
      where p.id = product_countries.product_id
        and p.seller_id = public.current_seller_id()
    )
  )
  with check (
    public.current_is_admin() or exists (
      select 1 from public.products p
      where p.id = product_countries.product_id
        and p.seller_id = public.current_seller_id()
    )
  );

-- customer_conversations
drop policy if exists "conversations_tenant" on public.customer_conversations;
create policy "conversations_tenant" on public.customer_conversations
  for all to authenticated
  using (seller_id = public.current_seller_id() or public.current_is_admin())
  with check (seller_id = public.current_seller_id() or public.current_is_admin());

-- messages — scoped via the parent conversation's seller_id.
drop policy if exists "messages_tenant" on public.messages;
create policy "messages_tenant" on public.messages
  for all to authenticated
  using (
    public.current_is_admin() or exists (
      select 1 from public.customer_conversations c
      where c.id = messages.conversation_id
        and c.seller_id = public.current_seller_id()
    )
  )
  with check (
    public.current_is_admin() or exists (
      select 1 from public.customer_conversations c
      where c.id = messages.conversation_id
        and c.seller_id = public.current_seller_id()
    )
  );

-- orders
drop policy if exists "orders_tenant" on public.orders;
create policy "orders_tenant" on public.orders
  for all to authenticated
  using (seller_id = public.current_seller_id() or public.current_is_admin())
  with check (seller_id = public.current_seller_id() or public.current_is_admin());

-- ═══════════════════════════════════════════════════════════════════════
-- Signup helper: create the seller row + the app_users link in one
-- atomic call. Frontend invokes this via Supabase RPC right after the
-- new auth.user is created.
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.create_seller_for_self(
  p_business_name     text,
  p_business_email    text,
  p_country_codes     text[] default '{}',
  p_default_language  text default 'en'
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_seller_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  -- Reject if this user already has an app_users row.
  if exists (select 1 from public.app_users where id = auth.uid()) then
    raise exception 'user already has a seller profile';
  end if;

  insert into public.sellers (business_name, business_email, country_codes, default_language)
    values (p_business_name, p_business_email, p_country_codes, p_default_language)
    returning id into v_seller_id;

  insert into public.app_users (id, seller_id, role)
    values (auth.uid(), v_seller_id, 'seller');

  return v_seller_id;
end;
$$;

revoke all on function public.create_seller_for_self(text, text, text[], text) from public;
grant execute on function public.create_seller_for_self(text, text, text[], text) to authenticated;

-- Touch trigger for `updated_at` columns.
create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_sellers_updated   on public.sellers;
create trigger trg_sellers_updated   before update on public.sellers
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_products_updated  on public.products;
create trigger trg_products_updated  before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_orders_updated    on public.orders;
create trigger trg_orders_updated    before update on public.orders
  for each row execute function public.touch_updated_at();
-- ═══════════════════════════════════════════════════════════════════════
-- 0002 — Per-product Google Sheets webhook + conversation-level pending
-- order fields.
--
--  • sellers.sheets_webhook_url is kept as the fallback. A new
--    products.sheets_webhook_url overrides it when the seller wants
--    confirmed orders for a specific product to land in their own sheet.
--  • customer_conversations.pending_order_fields accumulates the extracted
--    {name, address, city, quantity, ...} across turns so the brain can
--    push to Sheets the moment the customer confirms the order.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.products
  add column if not exists sheets_webhook_url text;

alter table public.customer_conversations
  add column if not exists pending_order_fields jsonb not null default '{}'::jsonb;
-- ═══════════════════════════════════════════════════════════════════════
-- 0003 — Bulk / tier pricing per product-country.
--
-- Some sellers advertise bulk discounts (e.g. 1 bottle = 299,000 GNF,
-- 2 bottles = 450,000 GNF instead of 598,000). product_countries.price
-- stays as the single-unit price (and the fallback for quantities not in
-- the tier map). price_tiers maps quantity → total_price for the bulk
-- deals the seller wants to advertise.
--
-- Example value:
--   {"1": 299000, "2": 450000, "3": 600000}
--
-- The brain reads this when computing an order's total_price, and the
-- bot mentions the available tiers when revealing prices in Stage 4.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.product_countries
  add column if not exists price_tiers jsonb not null default '{}'::jsonb;
