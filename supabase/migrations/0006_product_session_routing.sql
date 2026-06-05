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
