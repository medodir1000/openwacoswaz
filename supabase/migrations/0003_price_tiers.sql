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
