/**
 * SignupCompletePage — handles the "auth user exists but no app_users row"
 * limbo state that happens when Supabase's "Confirm email" toggle is on.
 *
 * Flow:
 *   1. Seller submits the signup form → auth.user created + sessionStorage
 *      stores their {business_name, country_codes, default_language}.
 *   2. If Supabase requires email confirmation, supabase.auth.signUp()
 *      returns session=null. The RPC create_seller_for_self() can't run
 *      yet because there's no auth.uid().
 *   3. Seller clicks the email confirmation link → they land back in the
 *      app authenticated.
 *   4. RequireAuth sees profile=null and routes here.
 *   5. This page reads sessionStorage and runs the RPC → seller + app_users
 *      rows created → auth.refreshProfile() → redirect to /admin.
 *
 * If sessionStorage is empty (different browser, cleared cache, etc.) we
 * show a minimal form so they can complete setup manually.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';

const STORAGE_KEY = 'leadecombot.pending_signup';

type PendingSignup = {
  business_name: string;
  business_email: string;
  country_codes: string[];
  default_language: string;
};

export function savePendingSignup(data: PendingSignup) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

function loadPendingSignup(): PendingSignup | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearPendingSignup() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

export default function SignupCompletePage() {
  const { loading, user, profile, refreshProfile } = useAuth();
  const nav = useNavigate();

  const [auto, setAuto] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Manual fallback form fields (used only if sessionStorage is empty).
  const [businessName, setBusinessName] = useState('');
  const [countries, setCountries] = useState('');
  const [language, setLanguage] = useState('en');
  const [submitting, setSubmitting] = useState(false);

  // Attempt auto-finish once auth + email are known.
  useEffect(() => {
    if (loading || !user || profile) return;            // wait, or already done
    if (auto !== 'idle') return;                        // already attempted
    const pending = loadPendingSignup();
    if (!pending) return;                               // fall back to manual form

    setAuto('running');
    (async () => {
      const { error } = await supabase.rpc('create_seller_for_self', {
        p_business_name: pending.business_name,
        p_business_email: pending.business_email,
        p_country_codes: pending.country_codes || [],
        p_default_language: pending.default_language || 'en',
      });
      if (error) {
        setAuto('failed');
        setError(error.message);
        return;
      }
      clearPendingSignup();
      await refreshProfile();
      setAuto('done');
      nav('/admin', { replace: true });
    })();
  }, [loading, user, profile, auto, nav, refreshProfile]);

  // Hooks must be unconditional — guards go AFTER. Boot states first:
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-zinc-500 text-xs uppercase tracking-[0.3em]">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (profile) {
    // Already onboarded — get them out of here.
    return <Navigate to="/admin" replace />;
  }

  // Manual fallback form — runs the RPC with whatever the user types here.
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cc = countries.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const { error } = await supabase.rpc('create_seller_for_self', {
        p_business_name: businessName,
        p_business_email: user!.email || 'unknown@example.com',
        p_country_codes: cc,
        p_default_language: language,
      });
      if (error) throw error;
      clearPendingSignup();
      await refreshProfile();
      nav('/admin', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50">
      <div className="glass-card rounded-2xl p-8 w-full max-w-lg">
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Finish your signup</p>
        <h1 className="text-3xl font-black tracking-tighter mt-1 mb-2">Almost there</h1>

        {auto === 'running' && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800 mb-4 inline-flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Finishing setup from your earlier signup…
          </div>
        )}

        {auto === 'failed' && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700 mb-4">
            Auto-finish failed: {error}. You can complete setup manually below.
          </div>
        )}

        <p className="text-sm text-zinc-600 mb-5">
          Your email is confirmed — one last step. Tell us your shop's basics and we'll create your tenant.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Business name</label>
            <input required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="form-input" placeholder="My Awesome Shop" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Countries you ship to</label>
              <input value={countries} onChange={(e) => setCountries(e.target.value)} className="form-input" placeholder="MA, FR, SA" />
              <p className="text-[10px] text-zinc-500 mt-1">ISO codes, comma-separated</p>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Default language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="form-input">
                <option value="en">English</option>
                <option value="fr">Français</option>
                <option value="ar">العربية</option>
                <option value="ary">Darija (Maghribia)</option>
                <option value="es">Español</option>
              </select>
            </div>
          </div>

          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">{error}</div>}

          <button type="submit" disabled={submitting} className="w-full inline-flex items-center justify-center gap-2 bg-electric-blue !text-white font-bold px-4 py-2.5 rounded-xl hover:bg-blue-600 disabled:opacity-50">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {submitting ? 'Creating shop…' : 'Finish setup'}
          </button>
        </form>
      </div>
    </div>
  );
}
