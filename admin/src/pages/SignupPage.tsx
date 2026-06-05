import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, Mail } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { savePendingSignup } from './SignupCompletePage';

/**
 * Signup flow:
 *   1. Create the auth.user via supabase.auth.signUp.
 *   2. Call the RPC create_seller_for_self() which atomically inserts
 *      a sellers row + an app_users row linking the new auth.uid() → seller_id.
 *   3. Redirect to /admin (RequireAuth will see the profile and let them in).
 *
 * NOTE: The RPC requires auth.uid() to be set, so this only works if email
 * confirmation is disabled in Supabase Auth settings, OR if we run it after
 * the user clicks the confirmation link. For MVP we set "auto-confirm
 * email" in Supabase Auth settings → Email → Confirm email off.
 */
export default function SignupPage() {
  const nav = useNavigate();
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [countries, setCountries] = useState('MA,FR');
  const [language, setLanguage] = useState('fr');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When email confirmation is enabled in Supabase Auth, signUp() returns
  // session=null and we have to wait for the user to click the email link.
  // We persist their form data so /signup/complete can finish setup the
  // moment they come back authenticated.
  const [emailConfirmationPending, setEmailConfirmationPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cc = countries.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      // Save form data BEFORE the auth call so we don't lose it if the
      // session never materializes (email confirmation path).
      savePendingSignup({
        business_name: businessName,
        business_email: email,
        country_codes: cc,
        default_language: language,
      });

      const { data, error: signErr } = await supabase.auth.signUp({ email, password });
      if (signErr) throw signErr;

      if (!data.session) {
        // Supabase Auth → "Confirm email" is ON. The user has to click the
        // email link; on their return the AuthContext picks up the session
        // and /signup/complete auto-finishes setup from sessionStorage.
        setEmailConfirmationPending(true);
        setBusy(false);
        return;
      }

      // Email confirmation is OFF — we can finish immediately.
      const { error: rpcErr } = await supabase.rpc('create_seller_for_self', {
        p_business_name: businessName,
        p_business_email: email,
        p_country_codes: cc,
        p_default_language: language,
      });
      if (rpcErr) throw rpcErr;
      nav('/admin', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // After a successful signup that requires email confirmation, swap the
  // form out for a "check your inbox" panel — much clearer than a thin
  // error banner under a form they can't usefully re-submit.
  if (emailConfirmationPending) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50">
        <div className="glass-card rounded-2xl p-8 w-full max-w-lg text-center">
          <div className="w-12 h-12 bg-blue-100 text-electric-blue rounded-full mx-auto flex items-center justify-center mb-4">
            <Mail className="w-6 h-6" />
          </div>
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">One more step</p>
          <h1 className="text-2xl font-black tracking-tighter mt-1 mb-3">Confirm your email</h1>
          <p className="text-sm text-zinc-600 mb-5">
            We sent a confirmation link to <strong>{email}</strong>. Click it and you'll be redirected back here to finish setup automatically.
          </p>
          <p className="text-xs text-zinc-500">
            Didn't get it? Check spam, or <Link to="/signup" className="text-electric-blue font-bold hover:underline">try a different email</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50">
      <div className="glass-card rounded-2xl p-8 w-full max-w-lg">
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Create your bot</p>
        <h1 className="text-3xl font-black tracking-tighter mt-1 mb-6">Sign up your shop</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Business name</label>
            <input required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="form-input" placeholder="My Awesome Shop" />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="form-input" autoComplete="email" />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Password</label>
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="form-input" autoComplete="new-password" />
            <p className="text-[10px] text-zinc-500 mt-1">Min 8 characters</p>
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

          <button type="submit" disabled={busy} className="w-full inline-flex items-center justify-center gap-2 bg-electric-blue !text-white font-bold px-4 py-2.5 rounded-xl hover:bg-blue-600 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {busy ? 'Creating…' : 'Create my bot'}
          </button>
        </form>

        <p className="text-sm text-zinc-600 mt-6 text-center">
          Already have an account? <Link to="/login" className="text-electric-blue font-bold hover:underline">Log in</Link>
        </p>
      </div>
    </div>
  );
}
