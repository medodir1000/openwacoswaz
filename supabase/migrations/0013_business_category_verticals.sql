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
