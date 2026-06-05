/**
 * AdminApprovals — codhelix platform admin's seller-approval queue.
 *
 * Mounted inside Layout (so we get the same sidebar as the seller view).
 * Shows every seller in the system grouped by status (pending → active →
 * disabled) so the admin can approve or reject newly-signed-up shops.
 *
 * Auth: uses the Supabase access_token captured at login (stashed in
 * sessionStorage as `codhelix_admin_token`). Every request to
 * /funnel/admin/* carries it as a Bearer token — the brain verifies it
 * against Supabase and checks app_users.role='admin'.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, Check, X, Globe2, Mail, Building2, Clock,
  CheckCircle2, MinusCircle, RefreshCw,
} from 'lucide-react';
import './AdminApprovals.css';

interface SellerRow {
  id: string;
  business_name: string;
  business_email: string;
  country_codes: string[];
  default_language: string;
  status: string;          // 'paused' | 'active' | 'disabled'
  display_status?: string; // brain decorates 'paused' as 'pending' for us
  created_at: string;
}

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  pending:  { label: 'Pending',  tone: 'tone-warn' },
  paused:   { label: 'Pending',  tone: 'tone-warn' },
  active:   { label: 'Active',   tone: 'tone-ok'   },
  disabled: { label: 'Rejected', tone: 'tone-bad'  },
};

export function AdminApprovals() {
  const token = sessionStorage.getItem('codhelix_admin_token') || '';

  const [filter, setFilter] = useState<'pending' | 'all' | 'active' | 'disabled'>('pending');
  const [rows, setRows] = useState<SellerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const r = await fetch(`/funnel/admin/sellers${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.status === 401) {
        setError('Session expired. Please sign in again.');
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || 'Could not load sellers');
        return;
      }
      setRows(j.sellers || []);
    } catch {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, [filter, token]);

  useEffect(() => { load(); }, [load]);

  async function act(seller: SellerRow, action: 'approve' | 'reject') {
    if (busyId) return;
    setBusyId(seller.id);
    try {
      const r = await fetch(`/funnel/admin/sellers/${seller.id}/${action}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `Could not ${action} seller`);
        return;
      }
      // Optimistic update — flip the row's status locally so the user
      // sees the change instantly, then refresh from the server in the
      // background to pick up anything else.
      setRows(prev => prev.map(row =>
        row.id === seller.id
          ? { ...row, status: action === 'approve' ? 'active' : 'disabled', display_status: action === 'approve' ? 'active' : 'disabled' }
          : row,
      ));
      // Background refetch (only if we're filtered on a status this row
      // no longer matches — otherwise leave the optimistic state alone).
      if (filter !== 'all') void load();
    } finally {
      setBusyId(null);
    }
  }

  const counts = {
    pending:  rows.filter(r => (r.display_status || r.status) === 'pending').length,
    active:   rows.filter(r => (r.display_status || r.status) === 'active').length,
    disabled: rows.filter(r => (r.display_status || r.status) === 'disabled').length,
  };

  return (
    <div className="admin-page">
      <main className="admin-main">
        <div className="admin-header">
          <h2>Seller approvals</h2>
          <p>Review new shop signups and approve, reject, or revisit existing accounts.</p>
        </div>

        <div className="admin-toolbar">
          <div className="admin-filters">
            <FilterChip active={filter === 'pending'}  onClick={() => setFilter('pending')}>
              <Clock size={14} /> Pending
              {filter === 'pending' && counts.pending > 0 && <span className="chip-count">{counts.pending}</span>}
            </FilterChip>
            <FilterChip active={filter === 'active'}   onClick={() => setFilter('active')}>
              <CheckCircle2 size={14} /> Active
            </FilterChip>
            <FilterChip active={filter === 'disabled'} onClick={() => setFilter('disabled')}>
              <MinusCircle size={14} /> Rejected
            </FilterChip>
            <FilterChip active={filter === 'all'}      onClick={() => setFilter('all')}>
              All
            </FilterChip>
          </div>
          <button className="admin-refresh" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>

        {error && (
          <div className="admin-error">{error}</div>
        )}

        {loading && rows.length === 0 ? (
          <div className="admin-empty">
            <Loader2 className="spin" size={28} />
            <p>Loading sellers…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="admin-empty">
            <CheckCircle2 size={36} />
            <p>No sellers match this filter.</p>
            <span>New signups will land here for review.</span>
          </div>
        ) : (
          <ul className="seller-list">
            {rows.map(seller => {
              const key = seller.display_status || seller.status || 'pending';
              const badge = STATUS_LABELS[key] || STATUS_LABELS.pending;
              const isPending = key === 'pending';
              const isDisabled = key === 'disabled';
              const busy = busyId === seller.id;
              return (
                <li key={seller.id} className="seller-card">
                  <div className="seller-main">
                    <div className="seller-avatar">
                      {seller.business_name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="seller-info">
                      <div className="seller-row1">
                        <h3>{seller.business_name}</h3>
                        <span className={`status-pill ${badge.tone}`}>{badge.label}</span>
                      </div>
                      <div className="seller-meta">
                        <span><Mail size={12} /> {seller.business_email}</span>
                        <span><Globe2 size={12} /> {seller.country_codes?.join(', ') || '—'}</span>
                        <span><Building2 size={12} /> Lang: {seller.default_language || 'en'}</span>
                      </div>
                      <div className="seller-date">
                        Signed up {new Date(seller.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="seller-actions">
                    {isPending && (
                      <>
                        <button
                          className="action-btn approve"
                          disabled={busy}
                          onClick={() => act(seller, 'approve')}
                        >
                          {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                          Approve
                        </button>
                        <button
                          className="action-btn reject"
                          disabled={busy}
                          onClick={() => act(seller, 'reject')}
                        >
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                    {!isPending && !isDisabled && (
                      <button
                        className="action-btn reject"
                        disabled={busy}
                        onClick={() => act(seller, 'reject')}
                      >
                        <X size={14} /> Disable
                      </button>
                    )}
                    {isDisabled && (
                      <button
                        className="action-btn approve"
                        disabled={busy}
                        onClick={() => act(seller, 'approve')}
                      >
                        <Check size={14} /> Re-enable
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function FilterChip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`filter-chip ${active ? 'is-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
