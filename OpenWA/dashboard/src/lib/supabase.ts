/**
 * ════════════════════════════════════════════════════════════════════
 *  Supabase browser client — lazily configured from the brain.
 * ════════════════════════════════════════════════════════════════════
 *
 * The dashboard never ships Supabase credentials in its bundle. Instead
 * the brain exposes the *public* values (project URL + anon key — both
 * safe to expose, they're guarded by RLS) on `GET /funnel/auth/config`.
 * We fetch that once, build a singleton client, and reuse it.
 *
 * This keeps a single source of truth (the brain's env) for which
 * Supabase project + which providers are live, and lets us flip Google
 * sign-in on/off server-side without rebuilding the frontend.
 *
 * The client is only ever used for OAuth (Google). Email/password auth
 * still goes through the brain's own `/funnel/auth/login|signup` so the
 * seller-provisioning logic stays in one place. After an OAuth redirect
 * we hand the resulting Supabase access_token to `/funnel/auth/oauth`,
 * which find-or-creates the seller and returns the same payload as a
 * normal login.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AuthConfig {
  supabase_url: string;
  supabase_anon_key: string;
  google_oauth: boolean;
}

let configPromise: Promise<AuthConfig | null> | null = null;
let client: SupabaseClient | null = null;

/**
 * Fetch (once) the public auth config from the brain. Cached for the life
 * of the tab. Returns null if the brain is unreachable or unconfigured —
 * callers should treat that as "OAuth unavailable, fall back to
 * email/password".
 */
export function getAuthConfig(): Promise<AuthConfig | null> {
  if (!configPromise) {
    configPromise = fetch('/funnel/auth/config', {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AuthConfig | null) => {
        if (data && data.supabase_url && data.supabase_anon_key) return data;
        return null;
      })
      .catch(() => null);
  }
  return configPromise;
}

/**
 * Lazily build the singleton Supabase client. Returns null when the
 * project isn't configured (so the UI can hide the Google button).
 *
 * `detectSessionInUrl` makes supabase-js automatically exchange the
 * `?code=` it finds after an OAuth redirect for a real session, and PKCE
 * is the secure browser flow (no client secret in the bundle).
 */
export async function getSupabase(): Promise<SupabaseClient | null> {
  if (client) return client;
  const cfg = await getAuthConfig();
  if (!cfg) return null;
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    auth: {
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}

/** True when the brain reports the Google provider is wired up. */
export async function isGoogleEnabled(): Promise<boolean> {
  const cfg = await getAuthConfig();
  return !!cfg?.google_oauth;
}

/**
 * Kick off the Google OAuth redirect. The browser leaves the page and
 * comes back to `redirectPath` (default: the current path, so a Google
 * click on /signup returns to /signup) with a `?code=` that supabase-js
 * turns into a session. App.tsx then exchanges it via /funnel/auth/oauth.
 *
 * Returns an error string on failure (e.g. provider not enabled), or null
 * when the redirect was initiated successfully.
 */
export async function signInWithGoogle(redirectPath?: string): Promise<string | null> {
  const supabase = await getSupabase();
  if (!supabase) return 'oauth_unavailable';
  const path = redirectPath || window.location.pathname || '/login';
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}${path}`,
      queryParams: { prompt: 'select_account' },
    },
  });
  return error ? error.message : null;
}

/**
 * Read the access_token from the current Supabase session, if any. Used
 * by App.tsx right after an OAuth redirect to detect that we just signed
 * in with Google and need to exchange the token with the brain.
 */
export async function getOAuthAccessToken(): Promise<string | null> {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Clear the local Supabase session (called from handleLogout). No-op when
 * Supabase was never configured. Scoped to 'local' so we only drop this
 * tab's session rather than revoking the refresh token everywhere.
 */
export async function supabaseSignOut(): Promise<void> {
  if (!client) return;
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch {
    /* best-effort — logout must never throw */
  }
}
