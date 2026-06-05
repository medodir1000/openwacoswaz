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
