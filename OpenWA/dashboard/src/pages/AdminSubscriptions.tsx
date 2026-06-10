import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import './AdminSubscriptions.css';

/**
 * Admin queue — manual subscription activation.
 *
 * Reviews `subscriptions` rows in status='pending_admin_review'.
 * Admin sees: customer org name, tier, months requested, total
 * amount + currency, payment_method, payment_reference (matches the
 * bank statement line), optional proof_url screenshot.
 *
 * Two actions per row:
 *  • Activate for N months (defaults to months_paid_for, can be
 *    adjusted if the customer paid for more/fewer months than asked).
 *    → POST /funnel/admin/subscriptions/:id/activate
 *  • Reject with a reason → POST /funnel/admin/subscriptions/:id/reject
 *
 * Endpoints are gated by _funnel_only_localhost() in brain.py, so this
 * page only works when accessed from the local network. In production
 * the dashboard runs behind the same reverse proxy as the brain, so
 * "localhost" includes the dashboard host.
 */

interface PendingSubscription {
  id: string;
  organization_id: string;
  tier: 'starter' | 'pro';
  status: string;
  amount_cents: number;
  currency: string;
  months_paid_for: number;
  payment_method: string | null;
  payment_proof_url: string | null;
  payment_reference: string | null;
  created_at: string;
  admin_notes: string | null;
  organizations?: {
    id: string;
    name: string;
    country_code: string | null;
  } | null;
}

const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'GNF']);

function fmt(amountMinor: number, currency: string): string {
  const isZeroDec = ZERO_DECIMAL.has(currency.toUpperCase());
  const major = isZeroDec ? amountMinor : amountMinor / 100;
  const formatted = major.toLocaleString('fr-FR').replace(/,/g, ' ');
  return `${formatted} ${currency}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function AdminSubscriptions() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PendingSubscription[] | null>(null);
  const [filter, setFilter] = useState<'pending_admin_review' | 'active' | 'rejected' | 'all'>('pending_admin_review');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-row local state — months override + admin notes + rejection reason.
  const [overrides, setOverrides] = useState<Record<string, { months?: number; notes?: string; rejectReason?: string }>>({});

  // Admin auth — the brain's _require_admin() reads the Supabase access token
  // from the Authorization header. Without it every admin call 403s (this page
  // was sending NO auth header → "HTTP 403" on load).
  function adminHeaders(): Record<string, string> {
    const token = sessionStorage.getItem('codhelix_admin_token') || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function load() {
    setError(null);
    try {
      const url = `/funnel/admin/subscriptions?status=${encodeURIComponent(filter)}`;
      const r = await fetch(url, { headers: adminHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setRows(j.subscriptions || []);
    } catch (e) {
      setError((e as Error).message || 'load failed');
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  async function activate(row: PendingSubscription) {
    const override = overrides[row.id] || {};
    const months_granted = override.months ?? row.months_paid_for ?? 1;
    setBusyId(row.id);
    try {
      const r = await fetch(`/funnel/admin/subscriptions/${row.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders() },
        body: JSON.stringify({
          months_granted,
          admin_notes: override.notes || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message || 'activate failed');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(row: PendingSubscription) {
    const override = overrides[row.id] || {};
    const reason = override.rejectReason || 'payment not received';
    setBusyId(row.id);
    try {
      const r = await fetch(`/funnel/admin/subscriptions/${row.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders() },
        body: JSON.stringify({ rejection_reason: reason }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message || 'reject failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-subs-page">
      <header className="admin-subs-header">
        <div>
          <h1>{t('adminSubs.title', 'Subscription requests')}</h1>
          <p className="admin-subs-subtitle">
            {t('adminSubs.subtitle',
               'Review pending subscription requests from sellers. Activate each one for the number of months they actually paid for.')}
          </p>
        </div>
        <div className="admin-subs-actions">
          <select
            className="admin-subs-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="pending_admin_review">{t('adminSubs.filter.pending', 'Pending review')}</option>
            <option value="active">{t('adminSubs.filter.active', 'Active')}</option>
            <option value="rejected">{t('adminSubs.filter.rejected', 'Rejected')}</option>
            <option value="all">{t('adminSubs.filter.all', 'All')}</option>
          </select>
          <button className="admin-subs-refresh" onClick={() => void load()}>
            <RefreshCw size={14} /> {t('common.refresh', 'Refresh')}
          </button>
        </div>
      </header>

      {error && (
        <div className="admin-subs-banner admin-subs-banner-err">{error}</div>
      )}

      {!rows && <p className="admin-subs-muted">{t('common.loading', 'Loading...')}</p>}

      {rows && rows.length === 0 && (
        <div className="admin-subs-empty">
          <p>{t('adminSubs.empty', 'No subscription requests in this category.')}</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="admin-subs-list">
          {rows.map((row) => {
            const o = overrides[row.id] || {};
            return (
              <div key={row.id} className={`admin-subs-card status-${row.status}`}>
                <div className="admin-subs-card-head">
                  <div>
                    <p className="admin-subs-eyebrow">
                      {timeAgo(row.created_at)} · {row.organizations?.country_code || '—'}
                    </p>
                    <h3>{row.organizations?.name || `Org ${row.organization_id.slice(0, 8)}`}</h3>
                    <p className="admin-subs-meta">
                      <strong>{row.tier === 'pro' ? 'Pack 2' : 'Pack 1'}</strong>
                      {' · '}{row.months_paid_for} {t('adminSubs.months', 'months')}
                      {' · '}<span className="admin-subs-total">{fmt(row.amount_cents, row.currency)}</span>
                    </p>
                  </div>
                  <span className={`admin-subs-pill status-${row.status}`}>
                    {t(`adminSubs.status.${row.status}` as const, row.status)}
                  </span>
                </div>

                <div className="admin-subs-card-body">
                  <div className="admin-subs-field">
                    <span className="admin-subs-label">{t('adminSubs.reference', 'Reference')}</span>
                    <code className="admin-subs-code">{row.payment_reference || '—'}</code>
                  </div>
                  <div className="admin-subs-field">
                    <span className="admin-subs-label">{t('adminSubs.paymentMethod', 'Method')}</span>
                    <span>{row.payment_method || '—'}</span>
                  </div>
                  {row.payment_proof_url && (
                    <div className="admin-subs-field">
                      <span className="admin-subs-label">{t('adminSubs.proof', 'Proof')}</span>
                      <a className="admin-subs-link" href={row.payment_proof_url} target="_blank" rel="noreferrer">
                        <ExternalLink size={12} /> {t('adminSubs.viewProof', 'View')}
                      </a>
                    </div>
                  )}
                  {row.admin_notes && (
                    <div className="admin-subs-field admin-subs-field-wide">
                      <span className="admin-subs-label">{t('adminSubs.adminNotes', 'Admin notes')}</span>
                      <span>{row.admin_notes}</span>
                    </div>
                  )}
                </div>

                {row.status === 'pending_admin_review' && (
                  <div className="admin-subs-card-foot">
                    <div className="admin-subs-control">
                      <label>{t('adminSubs.activateForMonths', 'Activate for')}</label>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={o.months ?? row.months_paid_for}
                        onChange={(e) => setOverrides((s) => ({
                          ...s,
                          [row.id]: { ...s[row.id], months: parseInt(e.target.value, 10) || 1 },
                        }))}
                      />
                      <span>{t('adminSubs.months', 'months')}</span>
                    </div>
                    <input
                      type="text"
                      className="admin-subs-notes"
                      placeholder={t('adminSubs.notesPlaceholder', 'Notes (optional)')}
                      value={o.notes ?? ''}
                      onChange={(e) => setOverrides((s) => ({
                        ...s,
                        [row.id]: { ...s[row.id], notes: e.target.value },
                      }))}
                    />
                    <button
                      className="admin-subs-btn admin-subs-btn-primary"
                      onClick={() => activate(row)}
                      disabled={busyId === row.id}
                    >
                      {busyId === row.id
                        ? <Loader2 size={14} className="spin" />
                        : <CheckCircle2 size={14} />}
                      {t('adminSubs.activate', 'Activate')}
                    </button>
                    <button
                      className="admin-subs-btn admin-subs-btn-danger"
                      onClick={() => reject(row)}
                      disabled={busyId === row.id}
                      title={t('adminSubs.reject', 'Reject')}
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AdminSubscriptions;
