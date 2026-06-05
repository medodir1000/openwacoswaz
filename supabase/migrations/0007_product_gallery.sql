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
