-- ═══════════════════════════════════════════════════════════════════════
-- LINK A NEWLY-PAIRED WHATSAPP NUMBER TO ITS SELLER
-- Run this in Supabase Studio → SQL Editor (project psnrabnwlqqlwezjfunp).
--
-- WHY: brain.py reads `seller_whatsapp_sessions` to (a) populate the Bot
-- Funnel "WhatsApp numbers" picker and (b) route inbound messages to the
-- right seller (openwa_resolve_seller_id). Nothing auto-writes this table
-- yet, so a number paired in OpenWA stays invisible AND the bot won't
-- reply on it until a row exists here.
--
-- This links the new number bot3 (+212608131488 / session
-- 00412b62-61f0-492a-a92e-e7f0e7006e12) to the active "biorien" seller
-- (1c468a81), which already owns the other two Moroccan numbers.
-- ═══════════════════════════════════════════════════════════════════════

insert into public.seller_whatsapp_sessions
  (seller_id, phone, jid, status, paired_at, last_seen_at)
values
  ('1c468a81-a1a3-4bf0-a9d7-fd8f69edaea7',  -- biorien (active, MA)
   '212608131488',                          -- the new number
   '00412b62-61f0-492a-a92e-e7f0e7006e12',  -- OpenWA session UUID (bot3)
   'connected',
   now(),
   now())
on conflict (seller_id, phone) do update
  set jid          = excluded.jid,
      status       = 'connected',
      last_seen_at = now();

-- Verify: should now list all THREE numbers for biorien.
select phone, jid, status, paired_at
  from public.seller_whatsapp_sessions
 where seller_id = '1c468a81-a1a3-4bf0-a9d7-fd8f69edaea7'
 order by paired_at desc;
