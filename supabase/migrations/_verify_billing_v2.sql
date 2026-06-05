-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY BILLING v2 MIGRATION LANDED
-- Run this in Supabase Studio → SQL Editor RIGHT AFTER pasting
-- _combined_billing_v2.sql, to confirm everything took.
--
-- You should see 5 rows, each with status = 'ok'.
-- ═══════════════════════════════════════════════════════════════════════

select
  'organizations table exists' as check,
  case when exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'organizations'
  ) then 'ok' else 'MISSING' end as status

union all

select
  'sellers.organization_id column exists',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sellers'
      and column_name = 'organization_id'
  ) then 'ok' else 'MISSING' end

union all

select
  'subscriptions table exists',
  case when exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'subscriptions'
  ) then 'ok' else 'MISSING' end

union all

select
  'subscriptions has manual-payment columns',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions'
      and column_name = 'months_paid_for'
  ) then 'ok' else 'MISSING' end

union all

select
  'every seller has an organization_id backfilled',
  case when (
    select count(*) from public.sellers where organization_id is null
  ) = 0 then 'ok'
    else 'MISSING — ' || (select count(*) from public.sellers where organization_id is null)::text || ' sellers unbackfilled'
  end;

-- Bonus: show the actual org rows so you can confirm your seller is in there.
select id, name, plan, ai_tokens_balance, country_code, created_at
  from public.organizations
  order by created_at desc
  limit 10;
