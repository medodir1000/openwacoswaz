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
