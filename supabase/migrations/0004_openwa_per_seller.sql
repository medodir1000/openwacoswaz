-- ═══════════════════════════════════════════════════════════════════════
-- 0004 — Per-seller OpenWA configuration.
--
-- The bot now talks to WhatsApp through OpenWA (whatsapp-web.js gateway)
-- instead of the legacy Baileys bridge. Each seller pairs their phone
-- inside OpenWA's dashboard, then pastes the resulting API key + session
-- ID into leadecombot's admin Settings page. Brain reads these per
-- request so multiple sellers can run on the same OpenWA instance (or
-- different ones).
--
-- `openwa_api_url` defaults to a local install but is overridable in case
-- the operator runs OpenWA on a separate host.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.sellers
  add column if not exists openwa_api_url    text not null default 'http://localhost:2785',
  add column if not exists openwa_api_key    text,
  add column if not exists openwa_session_id text;
