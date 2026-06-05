import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Save, Sparkles, Smartphone, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';

type SellerRow = {
  id: string;
  business_name: string;
  business_email: string;
  country_codes: string[];
  default_language: string;
  bot_persona: string;
  sheets_webhook_url: string | null;
  openrouter_model: string | null;
  daily_msg_cap: number;
  openwa_api_url: string | null;
  openwa_api_key: string | null;
  openwa_session_id: string | null;
};

const LANGUAGES = [
  { code: 'en',  label: 'English' },
  { code: 'fr',  label: 'Français' },
  { code: 'ar',  label: 'العربية' },
  { code: 'ary', label: 'Darija (Maghribia)' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'de', label: 'Deutsch' },
];

export default function AdminSettingsPage() {
  const { profile } = useAuth();
  const [seller, setSeller] = useState<SellerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.seller_id) return;
    (async () => {
      // Try the full select first (post-0004 migration). If the columns
      // don't exist yet, retry with the legacy column set so the page
      // still loads in dev environments that haven't applied 0004.
      let row: Partial<SellerRow> | null = null;
      let fetchErr: { message: string } | null = null;
      {
        const r = await supabase
          .from('sellers')
          .select('id, business_name, business_email, country_codes, default_language, bot_persona, sheets_webhook_url, openrouter_model, daily_msg_cap, openwa_api_url, openwa_api_key, openwa_session_id')
          .eq('id', profile.seller_id)
          .maybeSingle();
        row = (r.data as Partial<SellerRow> | null);
        fetchErr = r.error;
      }
      if (fetchErr && /openwa_/.test(fetchErr.message || '')) {
        const r2 = await supabase
          .from('sellers')
          .select('id, business_name, business_email, country_codes, default_language, bot_persona, sheets_webhook_url, openrouter_model, daily_msg_cap')
          .eq('id', profile.seller_id)
          .maybeSingle();
        row = (r2.data as Partial<SellerRow> | null);
        fetchErr = r2.error;
      }
      if (fetchErr) { setError(fetchErr.message); return; }
      const data = row;
      if (!data) { setError('Seller row not found'); return; }
      // Fill in defaults for new columns so the form always has values
      // (TypeScript needs them; the UI hides empty strings naturally).
      const normalized: SellerRow = {
        ...(data as Partial<SellerRow>),
        openwa_api_url:    (data as Partial<SellerRow>).openwa_api_url    ?? null,
        openwa_api_key:    (data as Partial<SellerRow>).openwa_api_key    ?? null,
        openwa_session_id: (data as Partial<SellerRow>).openwa_session_id ?? null,
      } as SellerRow;
      setSeller(normalized);
    })();
  }, [profile?.seller_id]);

  function set<K extends keyof SellerRow>(key: K, value: SellerRow[K]) {
    if (seller) setSeller({ ...seller, [key]: value });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!seller) return;
    setBusy(true);
    setError(null);
    // Try the full UPDATE first. If the openwa_* columns aren't there
    // yet (migration 0004 not applied), retry with the legacy set so
    // the rest of the form still saves.
    const fullPayload: Record<string, unknown> = {
      business_name: seller.business_name,
      country_codes: seller.country_codes,
      default_language: seller.default_language,
      bot_persona: seller.bot_persona,
      sheets_webhook_url: seller.sheets_webhook_url,
      daily_msg_cap: seller.daily_msg_cap,
      openwa_api_url:    seller.openwa_api_url || 'http://localhost:2785',
      openwa_api_key:    seller.openwa_api_key || null,
      openwa_session_id: seller.openwa_session_id || null,
    };
    let { error } = await supabase.from('sellers').update(fullPayload).eq('id', seller.id);
    if (error && /openwa_/.test(error.message || '')) {
      delete fullPayload.openwa_api_url;
      delete fullPayload.openwa_api_key;
      delete fullPayload.openwa_session_id;
      const retry = await supabase.from('sellers').update(fullPayload).eq('id', seller.id);
      error = retry.error;
    }
    setBusy(false);
    if (error) { setError(error.message); return; }
    setSavedAt(new Date());
  }

  if (!seller) {
    return <div className="p-10 text-zinc-500 text-sm">{error || 'Loading…'}</div>;
  }

  return (
    <div className="p-10 max-w-3xl space-y-8">
      <div>
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Configuration</p>
        <h1 className="text-4xl font-black tracking-tighter mt-1">Settings</h1>
        <p className="text-zinc-500 text-sm mt-1">Bot personality, target markets, and where confirmed orders land.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section title="Business">
          <Field label="Business name">
            <input value={seller.business_name} onChange={(e) => set('business_name', e.target.value)} className="form-input" />
          </Field>
          <Field label="Business email" hint="Read-only — change requires re-signup">
            <input value={seller.business_email} disabled className="form-input opacity-60" />
          </Field>
        </Section>

        <Section title="Bot personality">
          <Field label="Persona" hint="Use {{business_name}} as a placeholder — it auto-fills.">
            <textarea
              rows={4}
              value={seller.bot_persona}
              onChange={(e) => set('bot_persona', e.target.value)}
              className="form-input leading-relaxed"
            />
          </Field>
          <p className="text-xs text-zinc-500 -mt-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-electric-blue" />
            This is the system prompt sent to the LLM for every customer reply.
          </p>
        </Section>

        <Section title="Target markets">
          <Field label="Countries you ship to" hint="ISO 3166-1 alpha-2, comma-separated (MA, FR, SA, ES…)">
            <input
              value={(seller.country_codes || []).join(', ')}
              onChange={(e) => set('country_codes', e.target.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))}
              className="form-input"
              placeholder="MA, FR, SA"
            />
          </Field>
          <Field label="Default language" hint="Fallback if no per-product translation exists for the customer's country.">
            <select value={seller.default_language} onChange={(e) => set('default_language', e.target.value)} className="form-input">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </Field>
        </Section>

        <Section title="WhatsApp gateway">
          <p className="text-xs text-zinc-500 -mt-1 leading-relaxed">
            Pair your phone inside the codhelix gateway dashboard, then paste your API key and session ID here.
            The bot uses these credentials to receive customer messages and send replies.
          </p>
          <Field
            label="Gateway API URL"
            hint="Where your codhelix WhatsApp gateway is running. Default = local install on port 2785."
          >
            <input
              value={seller.openwa_api_url || 'http://localhost:2785'}
              onChange={(e) => set('openwa_api_url', e.target.value || null)}
              className="form-input font-mono text-sm"
              placeholder="http://localhost:2785"
            />
          </Field>
          <Field
            label="API key"
            hint="Generate in the gateway dashboard → API Keys → Create. Starts with owa_k1_."
          >
            <SecretInput
              value={seller.openwa_api_key || ''}
              onChange={(v) => set('openwa_api_key', v || null)}
              placeholder="owa_k1_..."
            />
          </Field>
          <Field
            label="Session ID"
            hint="The UUID shown for your paired WhatsApp session in the gateway → Sessions."
          >
            <input
              value={seller.openwa_session_id || ''}
              onChange={(e) => set('openwa_session_id', e.target.value || null)}
              className="form-input font-mono text-sm"
              placeholder="10a00bfa-a88f-4e58-b767-328b2f0368ff"
            />
          </Field>
          <a
            href={(seller.openwa_api_url || 'http://localhost:2785').replace(/:\d+$/, ':2886')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-electric-blue hover:underline"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open gateway dashboard
          </a>
          <p className="text-xs text-zinc-500 flex items-start gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-electric-blue shrink-0 mt-0.5" />
            <span>
              Each seller can run on the same gateway instance (share the API key) or a different one — just point to the right URL.
            </span>
          </p>
        </Section>

        <Section title="Order destination (default for this seller)">
          <Field
            label="Google Sheets webhook URL"
            hint='Apps Script Web App URL — confirmed orders POST here as JSON. Each product can override this from its own editor. Format: https://script.google.com/macros/s/AKfycb…/exec'
          >
            <input
              value={seller.sheets_webhook_url || ''}
              onChange={(e) => set('sheets_webhook_url', e.target.value || null)}
              className="form-input"
              placeholder="https://script.google.com/macros/s/.../exec"
            />
          </Field>
          <p className="text-xs text-zinc-500 -mt-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-electric-blue" />
            Per-product webhook URLs (configured in each product) take precedence over this one.
          </p>
        </Section>

        <Section title="Bot guardrails">
          <Field label="Daily message cap" hint="Anti-ban — WhatsApp soft-throttles aggressive senders. 80–250 is safe.">
            <input
              type="number"
              min={20}
              max={500}
              value={seller.daily_msg_cap}
              onChange={(e) => set('daily_msg_cap', parseInt(e.target.value || '200', 10))}
              className="form-input"
            />
          </Field>
        </Section>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-5 py-2 rounded-xl text-sm shadow-[0_0_25px_rgba(59,130,246,0.3)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {savedAt && <p className="text-xs text-green-600 font-bold">Saved at {savedAt.toLocaleTimeString()}</p>}
          {error && <p className="text-xs text-red-600 font-bold">✗ {error}</p>}
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl p-6 space-y-4">
      <h2 className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-zinc-500 mt-1">{hint}</p>}
    </div>
  );
}

// Input with a toggle eye that hides the value by default — used for
// sensitive credentials like API keys so the seller doesn't broadcast
// them on screen-shares or recordings.
function SecretInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="form-input font-mono text-sm pr-10"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-electric-blue p-1"
        aria-label={revealed ? 'Hide' : 'Reveal'}
      >
        {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
