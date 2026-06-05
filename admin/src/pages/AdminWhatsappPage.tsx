import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, LogOut, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';

// We dropped the legacy Baileys bridge — the WhatsApp connection now lives
// in OpenWA. Brain exposes a /wa/status proxy so this page still works
// without talking to OpenWA's API directly.
const BRAIN_URL = (import.meta.env.VITE_BRAIN_URL as string | undefined) ?? 'http://localhost:5001';
const BRIDGE_URL = (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://localhost:3002';

type BridgeStatus = {
  ok?: boolean;
  transport?: 'openwa' | 'baileys';
  status?: 'pending' | 'connected' | 'disconnected' | 'expired' | 'never_paired' | 'not_configured';
  jid?: string | null;
  phone?: string | null;
  push_name?: string | null;
  qrDataUrl?: string | null;
  pairingCode?: string | null;
  lastError?: string | null;
  connected_at?: string | null;
  connectedAt?: string | null;
  last_seen_at?: string | null;
  lastSeenAt?: string | null;
  openwa_status?: string;
  dashboard_url?: string;
};

export default function AdminWhatsappPage() {
  const { profile } = useAuth();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [busyKind, setBusyKind] = useState<null | 'pair' | 'unpair' | 'refresh'>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!profile?.seller_id) return;
    setBusyKind('refresh');
    try {
      // Try OpenWA-backed brain endpoint first; fall back to the legacy
      // Baileys bridge so this page keeps working if someone reverts.
      let data: BridgeStatus | null = null;
      try {
        const r = await fetch(`${BRAIN_URL}/wa/status`);
        if (r.ok) data = await r.json();
      } catch (_) { /* try fallback */ }
      if (!data) {
        const r = await fetch(`${BRIDGE_URL}/api/status?seller_id=${encodeURIComponent(profile.seller_id)}`);
        data = await r.json();
      }
      setStatus(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.seller_id]);

  async function startPair(mode: 'code' | 'qr' = 'code') {
    if (!profile?.seller_id) return;
    if (mode === 'code' && !phone.trim()) {
      setError('Enter your WhatsApp phone number first');
      return;
    }
    setBusyKind('pair');
    setError(null);
    try {
      const r = await fetch(`${BRIDGE_URL}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // QR mode omits the phone field — the bridge then skips
        // requestPairingCode and Baileys emits a QR for the user to scan
        // with their WhatsApp app. Useful when the pairing-code flow is
        // soft-blocked by WhatsApp's anti-bot detection.
        body: JSON.stringify(
          mode === 'qr'
            ? { seller_id: profile.seller_id }
            : { seller_id: profile.seller_id, phone: phone.trim() }
        ),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'pair failed');
      // The bridge starts the socket; status will reflect QR / code on the
      // next refresh tick (every 5s).
      setStatus({ ...status, pairingCode: data.pairingCode, qrDataUrl: data.qrDataUrl, status: 'pending' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  }

  async function unpair() {
    if (!profile?.seller_id) return;
    if (!confirm('Unpair will log out the bot from WhatsApp and wipe the saved credentials. Continue?')) return;
    setBusyKind('unpair');
    try {
      await fetch(`${BRIDGE_URL}/api/unpair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_id: profile.seller_id }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  }

  const isConnected = status?.status === 'connected';
  const isPending = status?.status === 'pending';

  return (
    <div className="p-10 max-w-3xl space-y-8">
      <div>
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Channel</p>
        <h1 className="text-4xl font-black tracking-tighter mt-1">WhatsApp</h1>
        <p className="text-zinc-500 text-sm mt-1">Pair your phone number to start receiving customer messages.</p>
      </div>

      {/* Status banner */}
      <div className={
        'glass-card rounded-2xl p-5 flex items-start gap-3 ' +
        (isConnected ? 'border-2 border-green-400' : isPending ? 'border-2 border-amber-400' : '')
      }>
        {isConnected
          ? <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
          : <AlertCircle className="w-6 h-6 text-amber-600 shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black">
            {isConnected ? 'Connected' :
             isPending ? 'Pairing in progress…' :
             status?.status === 'disconnected' ? 'Disconnected' :
             'Not paired yet'}
          </p>
          {status?.phone && <p className="text-xs text-zinc-500 mt-0.5">Phone: <code className="text-zinc-700">+{status.phone}</code>{status.push_name ? <> · {status.push_name}</> : null}</p>}
          {!status?.phone && status?.jid && <p className="text-xs text-zinc-500 mt-0.5">JID: <code className="text-zinc-700">{status.jid}</code></p>}
          {(status?.connected_at || status?.connectedAt) && <p className="text-xs text-zinc-500">Connected at: {new Date((status.connected_at || status.connectedAt)!).toLocaleString()}</p>}
          {status?.transport && <p className="text-xs text-zinc-500">Transport: <span className="font-mono">{status.transport}</span></p>}
          {status?.lastError && <p className="text-xs text-red-600">Last error: {status.lastError}</p>}
        </div>
        <button type="button" onClick={refresh} disabled={busyKind === 'refresh'} className="text-xs font-bold text-zinc-600 hover:text-electric-blue inline-flex items-center gap-1.5">
          {busyKind === 'refresh' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {/* Pairing flow */}
      {!isConnected && status?.transport === 'openwa' && (
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <h2 className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Pair your WhatsApp</h2>
          <p className="text-sm text-zinc-700">
            WhatsApp pairing for this seller is handled by the <strong>codhelix gateway dashboard</strong>.
            Create a session there, scan the QR (or use the pairing code), and this page
            will flip to <strong>Connected</strong> automatically on the next refresh.
          </p>
          <a
            href={status.dashboard_url || 'http://localhost:2886'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-5 py-2 rounded-xl text-sm"
          >
            <ExternalLink className="w-4 h-4" /> Open gateway dashboard
          </a>
          <p className="text-[11px] text-zinc-500">
            The gateway uses <code>whatsapp-web.js</code> + a headless Chrome instance — far less
            likely to be flagged than the legacy Baileys bridge.
          </p>
        </div>
      )}

      {/* Legacy Baileys-bridge pairing flow — only shown if status came
          from the bridge fallback, not OpenWA. */}
      {!isConnected && status?.transport !== 'openwa' && (
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <h2 className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Pair your WhatsApp (legacy)</h2>

          <div>
            <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">Phone number</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="form-input"
              placeholder="+447411202861"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              International format with country code. Digits only or with the leading <code>+</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => startPair('code')} disabled={busyKind === 'pair'} className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-5 py-2 rounded-xl text-sm disabled:opacity-50">
              {busyKind === 'pair' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Generate pairing code
            </button>
            <button type="button" onClick={() => startPair('qr')} disabled={busyKind === 'pair'} className="inline-flex items-center gap-2 bg-white border border-zinc-200 hover:border-electric-blue hover:text-electric-blue font-bold px-4 py-2 rounded-xl text-sm disabled:opacity-50">
              Pair with QR instead
            </button>
          </div>

          {status?.pairingCode && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mt-3">
              <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-blue-700 mb-1">8-digit pairing code</p>
              <p className="text-3xl font-mono font-black tracking-[0.3em] text-blue-900 text-center py-3 bg-white rounded-lg border border-blue-200">
                {status.pairingCode}
              </p>
              <ol className="text-xs text-blue-900 mt-3 space-y-1 list-decimal pl-5">
                <li>Open WhatsApp on your phone → Settings → Linked Devices → Link a Device</li>
                <li>Tap <strong>Link with phone number instead</strong> at the bottom</li>
                <li>Enter the 8-digit code above (within 60 seconds)</li>
                <li>Status flips to <strong>Connected</strong> automatically here</li>
              </ol>
            </div>
          )}

          {status?.qrDataUrl && (
            <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-center">
              <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-600 mb-2">Or scan this QR with WhatsApp's Linked Devices</p>
              <img src={status.qrDataUrl} alt="WhatsApp QR" className="w-56 h-56 mx-auto" />
            </div>
          )}
        </div>
      )}

      {/* Unpair / logout */}
      {isConnected && (
        <button type="button" onClick={unpair} disabled={busyKind === 'unpair'} className="inline-flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 font-bold px-4 py-2 rounded-xl text-sm">
          {busyKind === 'unpair' ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          Unpair WhatsApp
        </button>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2 text-xs text-red-700">✗ {error}</div>}
    </div>
  );
}
