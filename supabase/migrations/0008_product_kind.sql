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
