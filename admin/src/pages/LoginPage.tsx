import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const dest = (loc.state as { from?: string } | null)?.from || '/admin';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    nav(dest, { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50">
      <div className="glass-card rounded-2xl p-8 w-full max-w-md">
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Seller login</p>
        <h1 className="text-3xl font-black tracking-tighter mt-1 mb-6">Welcome back</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="form-input" autoComplete="email" />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="form-input" autoComplete="current-password" />
          </div>

          {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">{error}</div>}

          <button type="submit" disabled={busy} className="w-full inline-flex items-center justify-center gap-2 bg-electric-blue !text-white font-bold px-4 py-2.5 rounded-xl hover:bg-blue-600 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {busy ? 'Signing in…' : 'Log in'}
          </button>
        </form>

        <p className="text-sm text-zinc-600 mt-6 text-center">
          New seller? <Link to="/signup" className="text-electric-blue font-bold hover:underline">Create your shop's bot</Link>
        </p>
      </div>
    </div>
  );
}
