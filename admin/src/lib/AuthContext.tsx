/**
 * AuthContext — wraps the Supabase auth session + the app_users row that
 * maps the logged-in user to their seller_id and role.
 *
 * Pattern mirrors MediaHubAccess: every admin page hook into useAuth()
 * to know the current user, their role, and (for sellers) their tenant.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type AppRole = 'admin' | 'seller';

export type AppUser = {
  id: string;
  seller_id: string | null;
  role: AppRole;
};

type AuthState = {
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: AppUser | null;       // null until app_users row is fetched
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AppUser | null>(null);

  async function loadProfile(uid: string) {
    const { data, error } = await supabase
      .from('app_users')
      .select('id, seller_id, role')
      .eq('id', uid)
      .maybeSingle();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[auth] app_users fetch failed:', error.message);
      setProfile(null);
      return;
    }
    setProfile((data as AppUser | null) ?? null);
  }

  useEffect(() => {
    // Initial session load.
    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) await loadProfile(data.session.user.id);
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) loadProfile(sess.user.id);
      else setProfile(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  async function refreshProfile() {
    if (user) await loadProfile(user.id);
  }

  return (
    <AuthContext.Provider value={{ loading, session, user, profile, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
