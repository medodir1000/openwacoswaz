import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Paste them into admin/.env and restart `npm run dev`.',
  );
}

export const supabase = createClient(url || '', anonKey || '', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
