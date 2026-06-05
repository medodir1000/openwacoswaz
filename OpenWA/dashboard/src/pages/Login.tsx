import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Eye, EyeOff, Mail, Lock, User, Globe2, Loader2,
  ArrowRight, KeyRound, CheckCircle2, Clock, AlertCircle, Check,
  Sparkles, MessageSquare, ShieldCheck, Star, Zap,
  Target, Smartphone, Headphones, Rocket, CreditCard,
} from 'lucide-react';
import { signInWithGoogle, isGoogleEnabled, getSupabase, getOAuthAccessToken } from '../lib/supabase';
import './Login.css';

type Mode = 'signin' | 'signup' | 'apikey';

interface LoginProps {
  onLogin: (apiKey: string) => void;
  // Which view the form opens on. Driven by the public router so /login
  // opens "Log in" and /signup opens "Create account".
  initialMode?: Mode;
}

const COUNTRY_OPTIONS = [
  { code: 'MA', label: 'Morocco' },
  { code: 'FR', label: 'France' },
  { code: 'GN', label: 'Guinea' },
  { code: 'SN', label: 'Senegal' },
  { code: 'CI', label: "Côte d'Ivoire" },
  { code: 'DZ', label: 'Algeria' },
  { code: 'TN', label: 'Tunisia' },
  { code: 'SA', label: 'Saudi Arabia' },
  { code: 'AE', label: 'UAE' },
  { code: 'EG', label: 'Egypt' },
  { code: 'IL', label: 'Israel' },
  { code: 'US', label: 'United States' },
];

const LANGUAGE_OPTIONS = [
  { code: 'en',  label: 'English' },
  { code: 'fr',  label: 'Français' },
  { code: 'ar',  label: 'العربية' },
  // Moroccan Darija — written in Latin script with Arabizi numerals.
  // The brain's system prompt handles the actual writing style.
  { code: 'ary', label: 'Darija (Maghribia)' },
  { code: 'he',  label: 'עברית' },
  { code: 'es',  label: 'Español' },
];

export function Login({ onLogin, initialMode }: LoginProps) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'signin');
  const [showSecret, setShowSecret] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [country, setCountry] = useState('MA');
  const [language, setLanguage] = useState('en');
  const [apiKey, setApiKey] = useState('');

  const [pendingMode, setPendingMode] = useState<null | { kind: 'just_signed_up' | 'awaiting_approval'; businessName?: string }>(null);

  // First-time Google users land here after the OAuth exchange to finish
  // their profile (set a password + pick country/language) before the
  // dashboard opens. Holds the Supabase access_token we POST to
  // /funnel/auth/oauth/complete. null = not in onboarding.
  const [oauthOnboarding, setOauthOnboarding] = useState<null | { token: string; email: string; businessName?: string }>(null);
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  // Reveal the Google button only once the brain confirms the provider is
  // wired up — never show a button that can't work.
  useEffect(() => {
    let alive = true;
    isGoogleEnabled().then((ok) => { if (alive) setGoogleEnabled(ok); });
    return () => { alive = false; };
  }, []);

  // ── OAuth return ─────────────────────────────────────────────────────
  // After "Continue with Google", Supabase redirects back here with a
  // `?code=` (PKCE). supabase-js turns that into a session; we read its
  // access_token and hand it to the brain's /funnel/auth/oauth, which
  // find-or-creates the seller and returns the same payload as a normal
  // login. Reuses applyLoginPayload + the pending/error UI below.
  useEffect(() => {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));

    // Provider / Supabase bounced back with an error in the URL (e.g.
    // "Unable to exchange external code" → the Google provider's Client
    // Secret is wrong/missing in Supabase, or the user denied consent).
    // Surface a clean message instead of silently showing the form, and
    // keep the raw detail in the console for debugging.
    const oauthErr = url.searchParams.get('error') || hashParams.get('error');
    if (oauthErr) {
      const detail = url.searchParams.get('error_description')
        || hashParams.get('error_description') || oauthErr;
      console.warn('[oauth] provider returned an error:', detail);
      const friendly = /exchange external code/i.test(detail)
        ? "Google sign-in isn't fully configured yet (provider credentials). Use your email and password, or try again shortly."
        : 'Google sign-in could not be completed. Please try again, or use your email and password.';
      setError(friendly);
      window.history.replaceState({}, '', window.location.pathname || '/login');
      return;
    }

    const hasCode = url.searchParams.has('code')
      || window.location.hash.includes('access_token');
    if (!hasCode) return;
    let alive = true;
    setOauthBusy(true);
    const cleanUrl = () =>
      window.history.replaceState({}, '', window.location.pathname || '/login');
    (async () => {
      try {
        const token = await getOAuthAccessToken();
        if (!alive) return;
        if (!token) { setOauthBusy(false); cleanUrl(); return; }
        const r = await fetch('/funnel/auth/oauth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token, country_code: country, default_language: language }),
        });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        cleanUrl();
        if (r.status === 403 && (j.error === 'pending_approval' || j.error === 'account_suspended')) {
          setPendingMode({ kind: 'awaiting_approval', businessName: j.business_name });
          return;
        }
        if (!r.ok || !j.ok) { setError(j.message || j.error || 'Google sign-in failed'); return; }
        // Brand-new Google user → take them through a one-time onboarding
        // screen (set a password so they can also log in with email later,
        // and confirm their country + bot language). Existing users skip
        // straight into the dashboard.
        if (j.new_account === true) {
          setOauthOnboarding({
            token,
            email: (j.email as string) || '',
            businessName: (j.business_name as string) || '',
          });
          return;
        }
        applyLoginPayload(j, (j.email as string) || '');
      } catch {
        if (alive) { setError('Could not complete Google sign-in. Try again.'); cleanUrl(); }
      } finally {
        if (alive) setOauthBusy(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live password strength (signup only) — mirrors the brain's minimum +
  // the checklist shown in the UI.
  const pwChecks = {
    length: password.length >= 8,
    number: /\d/.test(password),
    upper: /[A-Z]/.test(password),
  };
  const pwValid = pwChecks.length && pwChecks.number && pwChecks.upper;

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setNotice('');
    setShowSecret(false);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNotice('');
    if (!email.trim() || !password) { setError('Email and password are required'); return; }
    setIsLoading(true);
    try {
      const r = await fetch('/funnel/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403 && j.error === 'pending_approval') {
        setPendingMode({ kind: 'awaiting_approval', businessName: j.business_name }); return;
      }
      if (!r.ok || !j.ok) { setError(j.message || j.error || 'Sign in failed'); return; }
      applyLoginPayload(j, email.trim());
    } catch {
      setError("Couldn't reach the server. Make sure the brain is running on :5001.");
    } finally { setIsLoading(false); }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNotice('');
    if (!email.trim() || !password || !businessName.trim()) {
      setError('Business name, email and password are required'); return;
    }
    if (!pwValid) { setError('Please meet all password requirements below'); return; }
    setIsLoading(true);
    try {
      const r = await fetch('/funnel/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(), password, business_name: businessName.trim(),
          country_codes: [country], default_language: language,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
        setError('An account with that email already exists. Try logging in instead.'); return;
      }
      if (!r.ok || !j.ok) { setError(j.message || j.error || 'Could not create account'); return; }

      // Instant free trial: the brain activates the account on signup
      // (status='active' + is_trial), so we can sign the seller straight in
      // with the same credentials — no admin-approval wait. If the chained
      // login fails for any reason we fall back to the confirmation screen.
      if (j.status === 'trial_active' || j.trial) {
        const ok = await autoLoginAfterSignup();
        if (ok) return;
      }
      setPendingMode({ kind: 'just_signed_up', businessName: j.business_name || businessName.trim() });
    } catch {
      setError("Couldn't reach the server. Make sure the brain is running on :5001.");
    } finally { setIsLoading(false); }
  }

  // Chained login immediately after a trial signup. The freshly created
  // seller is already status='active', so /funnel/auth/login returns a
  // usable gateway key (OPENWA_API_KEY fallback) — enough to drop them
  // straight into the dashboard. Returns true on success so the caller can
  // bail out, false to fall back to the "account created" screen.
  async function autoLoginAfterSignup(): Promise<boolean> {
    try {
      const r = await fetch('/funnel/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) return false;
      const key = j.openwa_api_key || '';
      if (!key) return false;
      if (j.seller_id) sessionStorage.setItem('leadecombot_seller_id', j.seller_id);
      if (j.business_name) sessionStorage.setItem('leadecombot_business_name', j.business_name);
      sessionStorage.setItem('codhelix_role', 'seller');
      sessionStorage.setItem('codhelix_email', j.email || email.trim());
      onLogin(key);
      return true;
    } catch {
      return false;
    }
  }

  // Shared success handoff for email/password login (also reused by the
  // OAuth exchange shape, which mirrors the same payload).
  function applyLoginPayload(j: Record<string, unknown>, fallbackEmail: string) {
    const role = (j.role as string) || 'seller';
    const payloadEmail = (j.email as string) || fallbackEmail;
    if (role === 'admin') {
      if (j.access_token) sessionStorage.setItem('codhelix_admin_token', j.access_token as string);
      sessionStorage.setItem('codhelix_role', 'admin');
      sessionStorage.setItem('codhelix_email', payloadEmail);
      const adminGwKey = (j.openwa_api_key as string) || '';
      if (adminGwKey) { onLogin(adminGwKey); return; }
      onLogin('__codhelix_admin__'); return;
    }
    const key = (j.openwa_api_key as string) || '';
    if (!key) {
      setError('Your account has no WhatsApp gateway API key yet. Open Bot Funnel → Settings after signing in.');
      return;
    }
    if (j.seller_id) sessionStorage.setItem('leadecombot_seller_id', j.seller_id as string);
    if (j.business_name) sessionStorage.setItem('leadecombot_business_name', j.business_name as string);
    sessionStorage.setItem('codhelix_role', 'seller');
    sessionStorage.setItem('codhelix_email', payloadEmail);
    onLogin(key);
  }

  // Finish onboarding for a first-time Google user: set their password (so
  // email + password login works too) and persist country + bot language,
  // then drop them into the dashboard with the normal login payload.
  async function handleOAuthComplete(e: React.FormEvent) {
    e.preventDefault();
    if (!oauthOnboarding) return;
    setError(''); setNotice('');
    if (!pwValid) { setError('Please meet all password requirements below'); return; }
    setOnboardingBusy(true);
    try {
      const r = await fetch('/funnel/auth/oauth/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: oauthOnboarding.token,
          password,
          country_code: country,
          default_language: language,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setError(j.message || j.error || 'Could not finish setup'); return; }
      applyLoginPayload(j, oauthOnboarding.email);
    } catch {
      setError("Couldn't reach the server. Make sure the brain is running on :5001.");
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function handleGoogle() {
    setError(''); setNotice('');
    setGoogleLoading(true);
    // signInWithGoogle redirects the browser away on success; we only get
    // back here (with a string) if it failed to start.
    const err = await signInWithGoogle(mode === 'signup' ? '/signup' : '/login');
    if (err) {
      setError(err === 'oauth_unavailable'
        ? "Google sign-in isn't configured yet. Use your email and password."
        : err);
      setGoogleLoading(false);
    }
  }

  async function handleApiKey(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNotice('');
    if (!apiKey.trim()) { setError('Please paste your API key'); return; }
    setIsLoading(true);
    try {
      const r = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      });
      if (r.ok) {
        sessionStorage.setItem('codhelix_role', 'seller');
        onLogin(apiKey);
      } else { setError('Invalid API key'); }
    } catch { setError("Couldn't reach the gateway server."); }
    finally { setIsLoading(false); }
  }

  // "Forgot password?" → send a Supabase reset email to the typed address.
  // Real behaviour, gracefully degraded when Supabase email isn't set up.
  async function handleForgotPassword() {
    setError(''); setNotice('');
    const target = email.trim();
    if (!target) { setError('Type your email above first, then tap “Forgot password?”'); return; }
    const supabase = await getSupabase();
    if (!supabase) { setError('Password reset isn’t available right now — contact support.'); return; }
    setIsLoading(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(target, {
        redirectTo: `${window.location.origin}/login`,
      });
      if (resetErr) setError(resetErr.message);
      else setNotice(`We sent a reset link to ${target}. Check your inbox.`);
    } catch {
      setError('Could not send the reset email. Try again later.');
    } finally { setIsLoading(false); }
  }

  // ── Account-state confirmation screen (post-signup / awaiting approval) ─
  if (pendingMode) {
    const justSignedUp = pendingMode.kind === 'just_signed_up';
    return (
      <div className="auth-shell" data-mode="signup">
        <div className="auth-main">
          <section className="auth-form-pane">
            <div className="auth-card pending-card">
              <div className="pending-icon">
                {justSignedUp ? <CheckCircle2 size={46} /> : <Clock size={46} />}
              </div>
              <h2 className="pending-title">
                {justSignedUp ? 'Account created' : 'Pending approval'}
              </h2>
              <p className="pending-message">
                {justSignedUp
                  ? `Welcome, ${pendingMode.businessName}. Your Closwiz account is ready and your free 2-day trial (30 conversations) is live — just log in to open your dashboard.`
                  : `Your account ${pendingMode.businessName ? `(${pendingMode.businessName})` : ''} is waiting for an administrator to approve it. Hang tight — we'll flip the switch as soon as we review your shop.`}
              </p>
              <button
                type="button"
                className="primary-btn"
                onClick={() => { setPendingMode(null); switchMode('signin'); setPassword(''); }}
              >
                <ArrowRight size={18} /> Back to log in
              </button>
            </div>
          </section>
          <SignupVisual />
        </div>
        <TrustBar />
      </div>
    );
  }

  // While exchanging a Google session for a seller key, show a calm
  // full-pane spinner instead of the form (the URL still carries ?code=).
  if (oauthBusy) {
    return (
      <div className="auth-shell" data-mode={mode === 'signup' ? 'signup' : 'signin'}>
        <div className="auth-main">
          <section className="auth-form-pane">
            <div className="auth-card pending-card">
              <div className="pending-icon"><Loader2 size={42} className="spin" /></div>
              <h2 className="pending-title">Finishing sign-in…</h2>
              <p className="pending-message">Connecting your Google account to Closwiz.</p>
            </div>
          </section>
          {mode === 'signup' ? <SignupVisual /> : <LoginVisual />}
        </div>
        <TrustBar />
      </div>
    );
  }

  // ── First-time Google user: finish the profile ─────────────────────────
  // Shown once, right after a brand-new "Continue with Google" sign-up.
  // Collects a password (so the seller can also log in with email later),
  // plus their country + bot language. Reuses the signup form's field +
  // checklist styling.
  if (oauthOnboarding) {
    return (
      <div className="auth-shell" data-mode="signup">
        <div className="auth-main">
          <section className="auth-form-pane">
            <div className="auth-card">
              <Link to="/" className="auth-logo-link" aria-label="Closwiz home">
                <span className="auth-logo-glow" aria-hidden />
                <img src="/closwiz_logo.svg" alt="Closwiz" className="auth-logo" />
                <span className="auth-logo-word">Closwiz</span>
              </Link>

              <header className="auth-header">
                <h1 className="auth-title">Almost there <Sparkles size={22} className="title-spark" /></h1>
                <p className="auth-subtitle">
                  {oauthOnboarding.email
                    ? `Signed in as ${oauthOnboarding.email}. Set a password and tell us where you sell.`
                    : 'Set a password and tell us where you sell.'}
                </p>
              </header>

              <form onSubmit={handleOAuthComplete} className="auth-form">
                <FormField icon={<Lock size={16} />} label="Create a password">
                  <input type={showSecret ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)} placeholder="Create a password"
                    autoComplete="new-password" required minLength={8} />
                  <button type="button" className="reveal-btn" onClick={() => setShowSecret(!showSecret)} aria-label="Toggle password visibility">
                    {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </FormField>

                {(password.length > 0) && (
                  <ul className="pw-checklist" aria-live="polite">
                    <PwRule ok={pwChecks.length}>At least 8 characters</PwRule>
                    <PwRule ok={pwChecks.number}>Include a number</PwRule>
                    <PwRule ok={pwChecks.upper}>Include an uppercase letter</PwRule>
                  </ul>
                )}

                <p className="field-note">
                  <ShieldCheck size={15} /> Next time you can log in with Google or this password.
                </p>

                <div className="form-row">
                  <FormField icon={<Globe2 size={16} />} label="Main country">
                    <select value={country} onChange={(e) => setCountry(e.target.value)}>
                      {COUNTRY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                    </select>
                  </FormField>
                  <FormField icon={<MessageSquare size={16} />} label="Bot language">
                    <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGE_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                  </FormField>
                </div>

                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" className="primary-btn" disabled={onboardingBusy}>
                  {onboardingBusy ? <Loader2 size={18} className="spin" /> : null}
                  {onboardingBusy ? 'Finishing…' : 'Finish setup'}
                  {!onboardingBusy ? <ArrowRight size={18} /> : null}
                </button>
              </form>
            </div>
          </section>
          <SignupVisual />
        </div>
        <TrustBar />
      </div>
    );
  }

  const headings: Record<Mode, { title: React.ReactNode; sub: string }> = {
    signin: { title: <>Welcome back <span className="wave">👋</span></>, sub: 'Log in to your Closwiz dashboard.' },
    signup: { title: <>Create your account <Sparkles size={22} className="title-spark" /></>, sub: 'Start your free trial — no credit card needed.' },
    apikey: { title: <>Use an API key <KeyRound size={20} className="title-spark" /></>, sub: 'Paste a raw OpenWA gateway key (operator install).' },
  };

  return (
    <div className="auth-shell" data-mode={mode === 'signup' ? 'signup' : 'signin'}>
      <div className="auth-main">
        {/* ── LEFT: the form ─────────────────────────────────────────── */}
        <section className="auth-form-pane">
          <div className="auth-card">
            <Link to="/" className="auth-logo-link" aria-label="Closwiz home">
              <span className="auth-logo-glow" aria-hidden />
              <img src="/closwiz_logo.svg" alt="Closwiz" className="auth-logo" />
              <span className="auth-logo-word">Closwiz</span>
            </Link>

            <header className="auth-header">
              <h1 className="auth-title">{headings[mode].title}</h1>
              <p className="auth-subtitle">{headings[mode].sub}</p>
            </header>

            {mode === 'signin' && (
              <form onSubmit={handleSignIn} className="auth-form">
                <FormField icon={<Mail size={16} />} label="Email">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com" autoComplete="username" required />
                </FormField>
                <FormField icon={<Lock size={16} />} label="Password"
                  aside={<button type="button" className="field-aside-link" onClick={handleForgotPassword}>Forgot password?</button>}>
                  <input type={showSecret ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                  <button type="button" className="reveal-btn" onClick={() => setShowSecret(!showSecret)} aria-label="Toggle password visibility">
                    {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </FormField>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                {notice && <NoticeBanner>{notice}</NoticeBanner>}
                <button type="submit" className="primary-btn" disabled={isLoading}>
                  {isLoading ? <Loader2 size={18} className="spin" /> : null}
                  {isLoading ? 'Logging in…' : 'Log In'}
                </button>
              </form>
            )}

            {mode === 'signup' && (
              <form onSubmit={handleSignUp} className="auth-form">
                <FormField icon={<User size={16} />} label="Business name">
                  <input value={businessName} onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="My Awesome Shop" autoComplete="organization" required />
                </FormField>
                <FormField icon={<Mail size={16} />} label="Email">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com" autoComplete="username" required />
                </FormField>
                <FormField icon={<Lock size={16} />} label="Password">
                  <input type={showSecret ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)} placeholder="Create a password"
                    autoComplete="new-password" required minLength={8} />
                  <button type="button" className="reveal-btn" onClick={() => setShowSecret(!showSecret)} aria-label="Toggle password visibility">
                    {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </FormField>

                {(password.length > 0) && (
                  <ul className="pw-checklist" aria-live="polite">
                    <PwRule ok={pwChecks.length}>At least 8 characters</PwRule>
                    <PwRule ok={pwChecks.number}>Include a number</PwRule>
                    <PwRule ok={pwChecks.upper}>Include an uppercase letter</PwRule>
                  </ul>
                )}

                <div className="form-row">
                  <FormField icon={<Globe2 size={16} />} label="Main country">
                    <select value={country} onChange={(e) => setCountry(e.target.value)}>
                      {COUNTRY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                    </select>
                  </FormField>
                  <FormField icon={<MessageSquare size={16} />} label="Bot language">
                    <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGE_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                  </FormField>
                </div>

                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" className="primary-btn" disabled={isLoading}>
                  {isLoading ? <Loader2 size={18} className="spin" /> : null}
                  {isLoading ? 'Creating…' : 'Create Account'}
                </button>
              </form>
            )}

            {mode === 'apikey' && (
              <form onSubmit={handleApiKey} className="auth-form">
                <FormField icon={<KeyRound size={16} />} label="API key">
                  <input type={showSecret ? 'text' : 'password'} value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)} placeholder="owa_k1_..."
                    autoComplete="off" required />
                  <button type="button" className="reveal-btn" onClick={() => setShowSecret(!showSecret)} aria-label="Toggle key visibility">
                    {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </FormField>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" className="primary-btn" disabled={isLoading}>
                  {isLoading ? <Loader2 size={18} className="spin" /> : null}
                  {isLoading ? 'Connecting…' : 'Connect'}
                </button>
              </form>
            )}

            {/* Social / OAuth — only for the real auth modes, not API-key */}
            {mode !== 'apikey' && googleEnabled && (
              <>
                <div className="auth-divider"><span>or continue with</span></div>
                <div className="social-row">
                  <button type="button" className="social-btn" onClick={handleGoogle} disabled={googleLoading}>
                    {googleLoading ? <Loader2 size={18} className="spin" /> : <GoogleGlyph />}
                    <span>Google</span>
                  </button>
                </div>
              </>
            )}

            {/* Footer mode switch */}
            <div className="auth-switch">
              {mode === 'signin' && (
                <>Don&apos;t have an account?{' '}
                  <button type="button" className="switch-link" onClick={() => switchMode('signup')}>Sign up</button>
                </>
              )}
              {mode === 'signup' && (
                <>Already have an account?{' '}
                  <button type="button" className="switch-link" onClick={() => switchMode('signin')}>Log in</button>
                </>
              )}
              {mode === 'apikey' && (
                <button type="button" className="switch-link" onClick={() => switchMode('signin')}>← Back to log in</button>
              )}
            </div>

            {mode !== 'apikey' && (
              <button type="button" className="apikey-hint" onClick={() => switchMode('apikey')}>
                <KeyRound size={13} /> Operator? Use an API key instead
              </button>
            )}
          </div>
        </section>

        {/* ── RIGHT: the visual showcase (dark for login, purple for signup) */}
        {mode === 'signup' ? <SignupVisual /> : <LoginVisual />}
      </div>

      <TrustBar />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 *  RIGHT-PANE VISUALS — pure CSS + SVG, no external photos.
 * ════════════════════════════════════════════════════════════════════ */

// ── LOGIN: dark panel, robot mascot, feature tiles, testimonial ─────────
function LoginVisual() {
  const features = [
    { icon: <MessageSquare size={18} />, label: 'Human-like conversations' },
    { icon: <Zap size={18} />,           label: 'Smart automation' },
    { icon: <Target size={18} />,        label: 'Capture & convert leads' },
    { icon: <Smartphone size={18} />,    label: 'Works where you do' },
  ];
  return (
    <aside className="auth-visual visual-dark">
      <div className="visual-orbs" aria-hidden>
        <span className="orb orb-a" /><span className="orb orb-b" /><span className="orb orb-c" />
      </div>
      <div className="visual-inner">
        <h2 className="visual-headline">
          AI conversations<br />that drive real <span className="accent-orange">results.</span>
        </h2>

        <div className="feature-grid">
          {features.map((f) => (
            <div className="feature-tile" key={f.label}>
              <span className="feature-ic">{f.icon}</span>
              <span>{f.label}</span>
            </div>
          ))}
        </div>

        <div className="mascot-wrap">
          <ChatMockup />
        </div>

        <figure className="testimonial">
          <div className="stars" aria-label="5 out of 5 stars">
            {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={15} fill="currentColor" />)}
          </div>
          <blockquote>“Closwiz has transformed the way we talk to our customers.”</blockquote>
          <figcaption>
            <span className="t-avatar" aria-hidden>A</span>
            <span className="t-meta">
              <strong>Aisha B.</strong>
              <span>E-commerce Founder</span>
            </span>
          </figcaption>
        </figure>
      </div>
    </aside>
  );
}

// ── SIGNUP: purple panel, persona illustration, floating stats ──────────
function SignupVisual() {
  const perks = [
    { icon: <CreditCard size={15} />, label: 'No credit card required' },
    { icon: <Rocket size={15} />,     label: 'Free forever plan' },
    { icon: <Zap size={15} />,        label: 'Setup in 2 minutes' },
  ];
  return (
    <aside className="auth-visual visual-purple">
      <div className="visual-orbs" aria-hidden>
        <span className="orb orb-a" /><span className="orb orb-b" /><span className="orb orb-c" />
      </div>
      <div className="visual-inner">
        <h2 className="visual-headline">Start free.<br />Grow fast.</h2>
        <p className="visual-lead">Join 2,000+ businesses turning WhatsApp chats into confirmed orders.</p>

        <ul className="perk-list">
          {perks.map((p) => (
            <li key={p.label}>
              <span className="perk-check"><Check size={13} strokeWidth={3} /></span>
              <span className="perk-ic">{p.icon}</span>
              {p.label}
            </li>
          ))}
        </ul>

        <div className="persona-stage">
          <ChatMockup />
        </div>

        <div className="connected-badge">
          <span className="cb-dot" /> Connected
          <span className="cb-icons">
            <ConnIcon kind="whatsapp" />
            <ConnIcon kind="shop" />
            <ConnIcon kind="sheet" />
          </span>
        </div>
      </div>
    </aside>
  );
}

// ── Bottom full-width trust bar (both screens) ──────────────────────────
function TrustBar() {
  return (
    <footer className="trust-bar">
      <span className="trust-item"><ShieldCheck size={16} /> Secure &amp; Private</span>
      <span className="trust-sep" aria-hidden />
      <span className="trust-item"><Rocket size={16} /> Easy Setup</span>
      <span className="trust-sep" aria-hidden />
      <span className="trust-item"><Headphones size={16} /> 24/7 Support</span>
    </footer>
  );
}

/* ── Premium WhatsApp chat mock — shared centerpiece for both panels ── */
function ChatMockup() {
  return (
    <div className="chat-mock" aria-hidden>
      <div className="chat-mock__bar">
        <span className="cm-avatar">C</span>
        <span className="cm-who"><strong>Customer</strong><em><i className="cm-live" /> online</em></span>
        <svg className="cm-wa" viewBox="0 0 24 24" width="20" height="20"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.82 11.82 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24z" fill="#25D366" /></svg>
      </div>
      <div className="chat-mock__msgs">
        <span className="cm-b cm-in">Is the black hoodie still in stock? 🖤</span>
        <span className="cm-b cm-out">Yes! Sizes M &amp; L left. Reserve one for you? 😊</span>
        <span className="cm-b cm-in">Size L please 🙌</span>
        <span className="cm-b cm-out">Done ✅ Order <b>#1042</b> confirmed — delivery tomorrow.</span>
      </div>
    </div>
  );
}

/* ── Tiny inline connector glyphs for the "Connected" badge ─────────── */
function ConnIcon({ kind }: { kind: 'whatsapp' | 'shop' | 'sheet' }) {
  if (kind === 'whatsapp') {
    return (
      <span className="conn-ic" style={{ background: '#25D366' }}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="#fff" aria-hidden>
          <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.9 5-1.3A10 10 0 1 0 12 2Zm5.2 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.5c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2 1.2.9 1.7.9 2 .8.2-.1.5-.5.7-.8.2-.2.3-.2.6-.1l1.9.9c.3.2.5.2.5.4.1.2.1.9-.1 1.5Z" />
        </svg>
      </span>
    );
  }
  if (kind === 'shop') {
    return (
      <span className="conn-ic" style={{ background: '#95BF47' }}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 2 3 6v14a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
      </span>
    );
  }
  return (
    <span className="conn-ic" style={{ background: '#0F9D58' }}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 3v18" />
      </svg>
    </span>
  );
}

/* ── Google "G" logo (inline, multicolor) ───────────────────────────── */
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

/* ── Small composable bits ──────────────────────────────────────────── */
function PwRule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? 'pw-rule ok' : 'pw-rule'}>
      <span className="pw-mark">{ok ? <Check size={12} strokeWidth={3} /> : <span className="pw-dot" />}</span>
      {children}
    </li>
  );
}

function FormField({
  icon, label, aside, children,
}: { icon: React.ReactNode; label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-top">
        <span className="field-label">
          <span className="field-icon">{icon}</span>
          {label}
        </span>
        {aside}
      </span>
      <span className="field-input">
        {children}
      </span>
    </label>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={16} />
      <span>{children}</span>
    </div>
  );
}

function NoticeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice-banner" role="status">
      <CheckCircle2 size={16} />
      <span>{children}</span>
    </div>
  );
}
