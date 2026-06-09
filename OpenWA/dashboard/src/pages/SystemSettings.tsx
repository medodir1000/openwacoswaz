/**
 * SystemSettings — admin-only screen for tweaking platform-wide config
 * the brain reads on every LLM call (so changes take effect immediately,
 * no restart required).
 *
 * Fields right now:
 *   - OpenRouter API key (write-only, masked preview of current value)
 *   - OpenRouter model   (e.g. openai/gpt-4o-mini, anthropic/claude-…)
 *
 * Storage is `api/data/system_settings.json` on the brain side. Brain
 * falls back to .env values when a key isn't set in the JSON, so the
 * existing deployment keeps working until the admin overrides anything.
 */
import { useEffect, useState } from 'react';
import {
  Eye, EyeOff, Loader2, Save, Server, Settings2,
  AlertCircle, CheckCircle2, RefreshCw, KeyRound,
} from 'lucide-react';
import './SystemSettings.css';

interface SettingsResponse {
  openrouter_key_masked: string;
  openrouter_key_present: boolean;
  openrouter_model: string;
  default_openwa_api_url: string;
  default_openwa_session: string;
  supabase_url: string;
  // Per-country payment methods shown to sellers on Billing. Effective =
  // admin override merged over the built-in defaults.
  payment_methods?: Record<string, unknown>;
  default_payment_methods?: Record<string, unknown>;
}

const SUGGESTED_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.0-flash-exp',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-large',
];

export function SystemSettings() {
  const token = sessionStorage.getItem('codhelix_admin_token') || '';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [current, setCurrent] = useState<SettingsResponse | null>(null);

  // Form state — only sent on Save.
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Payment methods editor (JSON), pre-filled with the effective per-country config.
  const [paymentJson, setPaymentJson] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/funnel/admin/settings', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.status === 401) { setError('Session expired. Please sign in again.'); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Could not load settings'); return; }
      setCurrent(j);
      setOpenrouterModel(j.openrouter_model || '');
      // Pre-fill the payment editor with the effective config (override merged
      // over defaults), so the admin edits the real values in place.
      try { setPaymentJson(JSON.stringify(j.payment_methods || {}, null, 2)); }
      catch { setPaymentJson('{}'); }
    } catch {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const body: Record<string, string> = {};
      // Only send the key if the admin typed something — empty string
      // is a sentinel that means "clear the override and fall back to
      // .env". We hide the existing masked value in the input.
      if (openrouterKey.trim() !== '') {
        body.openrouter_api_key = openrouterKey.trim();
      }
      if (openrouterModel.trim() !== '' && openrouterModel.trim() !== current?.openrouter_model) {
        body.openrouter_model = openrouterModel.trim();
      }
      if (Object.keys(body).length === 0) {
        setSuccessMsg('Nothing changed.');
        setSaving(false);
        return;
      }
      const r = await fetch('/funnel/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Save failed'); return; }
      setSuccessMsg(`Saved (${(j.updated || []).join(', ') || 'no changes'}).`);
      setOpenrouterKey('');
      // Re-fetch to refresh the masked preview.
      await load();
    } catch {
      setError('Could not reach the server');
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!confirm('Clear the OpenRouter key override? The brain will fall back to its .env value (which may be empty).')) return;
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const r = await fetch('/funnel/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ openrouter_api_key: '' }),
      });
      if (!r.ok) { setError('Could not clear the key'); return; }
      setSuccessMsg('Cleared. Falling back to .env value.');
      setOpenrouterKey('');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function savePayments() {
    setPaySaving(true); setError(null); setSuccessMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(paymentJson);
    } catch {
      setError('Payment methods: invalid JSON — check the brackets and commas.');
      setPaySaving(false);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Payment methods must be an object keyed by country code (e.g. { "MA": [...] }).');
      setPaySaving(false);
      return;
    }
    try {
      const r = await fetch('/funnel/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ payment_methods: parsed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Save failed'); return; }
      setSuccessMsg('Payment methods saved — sellers now see your real details on Billing.');
      await load();
    } catch {
      setError('Could not reach the server');
    } finally {
      setPaySaving(false);
    }
  }

  return (
    <div className="sys-page">
      <div className="sys-header">
        <div>
          <h2>System settings</h2>
          <p>Platform-wide knobs. Changes apply instantly — no restart needed.</p>
        </div>
        <button className="sys-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <div className="sys-banner sys-banner-err">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {successMsg && (
        <div className="sys-banner sys-banner-ok">
          <CheckCircle2 size={16} /> {successMsg}
        </div>
      )}

      <section className="sys-card">
        <div className="sys-card-head">
          <Settings2 size={18} />
          <h3>LLM (OpenRouter)</h3>
        </div>
        <p className="sys-card-sub">
          The bot talks to customers through OpenRouter. Paste a key from
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer"> openrouter.ai/keys</a>.
        </p>

        <label className="sys-field">
          <span className="sys-label">
            <KeyRound size={14} /> OpenRouter API key
          </span>
          <div className="sys-input-wrap">
            <input
              type={showKey ? 'text' : 'password'}
              value={openrouterKey}
              onChange={(e) => setOpenrouterKey(e.target.value)}
              placeholder={current?.openrouter_key_present
                ? `Current: ${current.openrouter_key_masked} — type to replace`
                : 'sk-or-v1-...'}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="sys-eye" onClick={() => setShowKey(v => !v)}>
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <span className="sys-hint">
            Stored in <code>api/data/system_settings.json</code>. Leave empty to keep the current value.
          </span>
        </label>

        <label className="sys-field">
          <span className="sys-label"><Settings2 size={14} /> Model</span>
          <div className="sys-input-wrap">
            <input
              list="model-options"
              value={openrouterModel}
              onChange={(e) => setOpenrouterModel(e.target.value)}
              placeholder="openai/gpt-4o-mini"
              spellCheck={false}
            />
            <datalist id="model-options">
              {SUGGESTED_MODELS.map(m => <option key={m} value={m} />)}
            </datalist>
          </div>
          <span className="sys-hint">
            Any OpenRouter-compatible model slug. Cheaper = faster + fewer tokens; bigger = better Arabic/French quality.
          </span>
        </label>

        <div className="sys-actions">
          {current?.openrouter_key_present && (
            <button type="button" className="sys-ghost" onClick={clearKey} disabled={saving}>
              Clear override
            </button>
          )}
          <button type="button" className="sys-primary" onClick={save} disabled={saving || loading}>
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className="sys-card">
        <div className="sys-card-head">
          <KeyRound size={18} />
          <h3>Payment methods (per country)</h3>
        </div>
        <p className="sys-card-sub">
          What sellers see on the <strong>Billing</strong> page when they subscribe.
          Put your <strong>real</strong> RIB / Orange Money numbers here — they're
          stored privately in the database, <strong>never in the code/git</strong>.
          Keyed by 2-letter country (<code>MA</code>, <code>SN</code>, <code>GN</code>, <code>CI</code>…);
          a seller sees the entry for their country.
        </p>
        <label className="sys-field">
          <span className="sys-label"><Settings2 size={14} /> payment_methods (JSON)</span>
          <textarea
            value={paymentJson}
            onChange={(e) => setPaymentJson(e.target.value)}
            spellCheck={false}
            rows={16}
            style={{
              width: '100%', fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              fontSize: '0.8rem', lineHeight: 1.5, padding: '.7rem .85rem',
              borderRadius: '10px', border: '1.5px solid #e6e8f0', background: '#fbfbfe',
              color: '#1a1d29', resize: 'vertical',
            }}
          />
          <span className="sys-hint">
            Each country → a list of <code>{`{ method, label, details, instructions }`}</code>.
            Edit mainly <code>details</code> (your RIB / Orange Money number) and
            <code>instructions</code>. Example — <code>"details": "Orange Money : +221 77 123 45 67 (Nom)"</code>.
            Remove a country to fall back to the built-in default.
          </span>
        </label>
        <div className="sys-actions">
          <button type="button" className="sys-primary" onClick={savePayments} disabled={paySaving || loading}>
            {paySaving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {paySaving ? 'Saving…' : 'Save payment methods'}
          </button>
        </div>
      </section>

      <section className="sys-card sys-card-readonly">
        <div className="sys-card-head">
          <Server size={18} />
          <h3>Defaults from <code>.env</code> (read-only)</h3>
        </div>
        <p className="sys-card-sub">
          For per-seller overrides go to the Approvals page → open a seller
          (coming up). These are the fallbacks the brain uses when a seller
          hasn't configured their own values.
        </p>
        <dl className="sys-defaults">
          <div>
            <dt>Default OpenWA URL</dt>
            <dd>{current?.default_openwa_api_url || '—'}</dd>
          </div>
          <div>
            <dt>Default OpenWA Session</dt>
            <dd className="mono">{current?.default_openwa_session || '—'}</dd>
          </div>
          <div>
            <dt>Supabase project</dt>
            <dd className="mono">{current?.supabase_url || '—'}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
