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
