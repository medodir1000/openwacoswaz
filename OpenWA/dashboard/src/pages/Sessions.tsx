import { useState, useEffect, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, QrCode, RefreshCw, Trash2, Eye, Loader2, Play, Square, X, Search, Filter } from 'lucide-react';
import { sessionApi, type Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRole } from '../hooks/useRole';
import { useOrganization } from '../hooks/useOrganization';
import { PageHeader } from '../components/PageHeader';
import { AccessGate } from '../components/AccessGate';
import './Sessions.css';

// Statuses where a freshly-created number is still pairing (no phone yet, so
// the brain can't attribute it to the seller). We keep such locally-created
// rows visible across a tenant-scoped refetch until they pair.
const PENDING_STATUSES: Session['status'][] = ['created', 'initializing', 'connecting', 'qr_ready'];

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [qrData, setQrData] = useState<{ sessionId: string; sessionName: string; qrCode: string; connected?: boolean } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Tombstones — ids the user just deleted. fetchSessions re-runs on
  // create/start/QR-connect and can RACE a delete: an in-flight list (or the
  // local "pendingLocal" merge of a freshly-created session) would re-surface a
  // card the user just removed. Excluding these ids guarantees a deleted
  // session never comes back on its own. (Reset on reload — the backend then
  // truly has no row, verified server-side, so it won't reappear anyway.)
  const deletedIdsRef = useRef<Set<string>>(new Set());

  // Per-plan WhatsApp-session cap. Free trial = 1 number; paid tiers use
  // their sessions_included. Enforced here for clean UX; the brain also
  // rejects over-cap registers as a hard backstop.
  const org = useOrganization();
  const sessionLimit = org.is_trial ? 1 : Math.max(1, org.sessions_included || 1);
  const atSessionLimit = sessions.length >= sessionLimit;
  const blocked = !org.access.allowed;  // free trial ended, no active paid plan
  const notifyLimit = () =>
    toast.error(
      t('sessions.limit.title', 'Session limit reached'),
      org.is_trial
        ? t('sessions.limit.trial', 'Your free trial allows 1 WhatsApp session. Delete the extra ones or upgrade to connect more.')
        : t('sessions.limit.plan', 'Your plan allows {{count}} WhatsApp session(s).', { count: sessionLimit }),
    );

  useWebSocket({
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        setSessions(prev =>
          prev.map(s => (s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s)),
        );
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        }
      },
      [toast, t],
    ),
  });

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
      if (sellerId) {
        // Seller context → show ONLY this seller's own WhatsApp numbers
        // (brain, tenant-scoped). The raw gateway list returns every tenant's
        // session because all sellers share one gateway + master key, so it
        // would surface other sellers' numbers and stale test sessions here.
        const owned = await sessionApi.listOwned(sellerId);
        setSessions(prev => {
          const dead = deletedIdsRef.current;
          const liveOwned = owned.filter(s => !dead.has(s.id));
          const ownedIds = new Set(liveOwned.map(s => s.id));
          // A number created this browser-session but still mid-pairing has no
          // phone yet, so the brain can't attribute it. Keep it visible until
          // it pairs (then it joins `owned`) or the page is reloaded — unless
          // the user deleted it (tombstone).
          const pendingLocal = prev.filter(
            s => !ownedIds.has(s.id) && !dead.has(s.id) && PENDING_STATUSES.includes(s.status),
          );
          return [...liveOwned, ...pendingLocal];
        });
      } else {
        // Admin context (no tenant) → full fleet view across all sellers.
        const data = await sessionApi.list();
        setSessions(data.filter(s => !deletedIdsRef.current.has(s.id)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Open the QR modal immediately in a loading state; the poll effect below
  // fills in the code once the engine emits it (a few seconds after start).
  const openQrModal = useCallback((id: string, name: string) => {
    setQrData({ sessionId: id, sessionName: name, qrCode: '' });
  }, []);

  // One poll tick. "ready" → the number connected, so close + refresh. A code
  // → render it. ANY error (including the gateway's "QR not ready yet" right
  // after start) is swallowed so we KEEP polling instead of bailing to a dead
  // modal — the engine emits the QR a few seconds after the session starts.
  const pollQR = useCallback(async (sessionId: string): Promise<boolean> => {
    // Authoritative connect check FIRST. The /qr endpoint throws 400 ("already
    // authenticated") the instant the number links — the engine clears its QR —
    // so "connected" can NEVER arrive through getQR (its status:'ready' path is
    // unreachable once linked). Ask the session's REAL status instead: READY =
    // linked. This is the bit that was missing — the modal used to hang on the
    // stale QR until a manual reload.
    try {
      const s = await sessionApi.get(sessionId);
      if (s.status === 'ready') {
        // Flip into the success animation. The auto-close effect below fires
        // the toast + list refresh once, then closes the modal a beat later.
        setQrData(prev => (prev && prev.sessionId === sessionId ? { ...prev, connected: true } : prev));
        return true; // stop polling — connected
      }
    } catch {
      /* transient status read — fall through and try to refresh the QR image */
    }
    // Not connected yet → keep a fresh, scannable code (it also rotates server
    // side every ~20s). A 400 here ("QR not ready" / "already authenticated")
    // is expected and swallowed; the status check above is the connect signal.
    try {
      const qr = await sessionApi.getQR(sessionId);
      if (qr.qrCode) {
        setQrData(prev => (prev && prev.sessionId === sessionId ? { ...prev, qrCode: qr.qrCode } : prev));
      }
    } catch {
      /* expected while pairing or once authenticated — keep polling */
    }
    return false; // keep polling
  }, []);

  // Poll while a QR modal is open. Re-fetches every 2.5s (the QR also rotates
  // on the WhatsApp side, so a short cadence keeps a fresh, scannable code),
  // with a ~5min safety cap so we don't poll a forgotten modal forever. The
  // interval is torn down the instant the modal closes, so this only bounds a
  // left-open modal — a slow scan still gets auto-detected + closed.
  useEffect(() => {
    const sid = qrData?.sessionId;
    if (!sid) return;
    let attempts = 0;
    void pollQR(sid); // immediate first attempt
    qrPollRef.current = setInterval(() => {
      void (async () => {
        attempts += 1;
        const done = await pollQR(sid);
        if ((done || attempts >= 120) && qrPollRef.current) {
          clearInterval(qrPollRef.current);
          qrPollRef.current = null;
        }
      })();
    }, 2500);
    return () => {
      if (qrPollRef.current) {
        clearInterval(qrPollRef.current);
        qrPollRef.current = null;
      }
    };
    // Only re-arm when the *session* changes, not on every qrCode update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrData?.sessionId, pollQR]);

  // After the number links: fire the success side-effects exactly once on the
  // connect transition (celebrate + refresh the list so it shows as linked),
  // let the checkmark play for a beat, then close the modal on its own.
  useEffect(() => {
    if (!qrData?.connected) return;
    toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
    fetchSessions();
    const id = setTimeout(() => setQrData(null), 2800);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrData?.connected]);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    if (blocked) {
      setShowCreateModal(false);
      toast.error(
        t('access.blockedTitle', 'Essai gratuit terminé'),
        t('access.blockedDesc', 'Choisissez un plan pour réactiver vos sessions WhatsApp, produits et services.'),
      );
      return;
    }
    if (atSessionLimit) { setShowCreateModal(false); notifyLimit(); return; }
    try {
      setCreating(true);
      const newSession = await sessionApi.create(newSessionName);
      // Claim the session for THIS seller so it persists after a refresh and
      // inbound routes to them — the gateway create is tenant-blind, so without
      // this the new session has no seller→session row and vanishes on reload.
      // Non-fatal: the session still exists on the gateway if this fails.
      const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
      if (sellerId) {
        try { await sessionApi.registerOwned(sellerId, newSession.id); } catch { /* non-fatal */ }
      }
      setSessions(prev => [...prev, newSession]);
      setNewSessionName('');
      setShowCreateModal(false);
      toast.success(t('sessions.create.successTitle'), t('sessions.create.successDesc', { name: newSession.name }));
      // Go straight to pairing: start the engine and pop the QR modal, so
      // creating a session flows directly into "scan to connect" instead of
      // leaving a dead "NOUVELLE" card the seller has to hunt buttons on.
      void handleStart(newSession.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.create.errorDefault');
      setError(msg);
      toast.error(t('sessions.create.errorTitle'), msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
    // Tombstone FIRST — so any list refetch that lands mid-delete already
    // excludes it (no flicker-back while the gateway/brain deletes settle).
    deletedIdsRef.current.add(id);
    try {
      // 1) Best-effort gateway delete. A 404 means it's already gone (orphan).
      //    For a SELLER, even a real gateway error (500, or the gateway being
      //    down → 502) must NOT strand an undeletable card — the brain
      //    unregister below is the authoritative removal, so we swallow & warn
      //    and fall through. For an ADMIN (no brain row) a non-404 gateway error
      //    IS the failure → rethrow it.
      try {
        await sessionApi.delete(id);
      } catch (err) {
        const m = err instanceof Error ? err.message.toLowerCase() : '';
        const goneOnGateway = m.includes('not found') || m.includes('404');
        if (!goneOnGateway) {
          if (!sellerId) throw err;
          console.warn('Gateway delete failed; clearing via brain unregister:', err);
        }
      }
      // 2) For a seller the list is sourced from the brain (seller_whatsapp_sessions),
      //    so unregistering that row is what makes the card STAY gone after a
      //    reload. This is the authoritative step — if it throws, surface it.
      if (sellerId) {
        await sessionApi.unregisterOwned(sellerId, id);
      }
      setSessions(prev => prev.filter(s => s.id !== id));
      toast.success(
        t('sessions.delete.successTitle'),
        session ? t('sessions.delete.successDescNamed', { name: session.name }) : t('sessions.delete.successDescGeneric'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.delete.errorDefault');
      console.error('Failed to delete:', err);
      toast.error(t('sessions.delete.errorTitle'), msg);
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleStart = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session && ['initializing', 'connecting', 'qr_ready'].includes(session.status)) {
      handleShowQR(id);
      return;
    }

    try {
      await sessionApi.start(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'connecting' } : s)));
      await fetchSessions();
      handleShowQR(id);
    } catch (err) {
      console.error('Failed to start:', err);
      await fetchSessions();
      if (err instanceof Error && err.message.includes('already started')) {
        handleShowQR(id);
      }
    }
  };

  const handleShowQR = (id: string) => {
    const session = sessions.find(s => s.id === id);
    // Open the modal in its loading state; pollQR keeps trying until the
    // engine produces the code (no more bailing on "QR not ready yet").
    openQrModal(id, session?.name || '');
  };

  const handleStop = async (id: string) => {
    try {
      await sessionApi.stop(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      if (qrData?.sessionId === id) setQrData(null);
    } catch (err) {
      console.error('Failed to stop:', err);
      fetchSessions();
    }
  };

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const filteredSessions = sessions.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && s.status === 'ready') ||
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected'].includes(s.status)) ||
      (statusFilter === 'connecting' && ['initializing', 'connecting', 'qr_ready'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div
        className="sessions-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          canWrite && (
            <button
              className="btn-primary"
              onClick={() => (atSessionLimit ? notifyLimit() : setShowCreateModal(true))}
              disabled={blocked}
              title={blocked ? t('access.blockedTitle', 'Essai gratuit terminé') : undefined}
            >
              <Plus size={18} />
              {t('sessions.newSession')}
            </button>
          )
        }
      />

      <AccessGate access={org.access} />

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('sessions.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">{t('sessions.filter.all')}</option>
            <option value="active">{t('sessions.filter.active')}</option>
            <option value="inactive">{t('sessions.filter.inactive')}</option>
            <option value="connecting">{t('sessions.filter.connecting')}</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: '#FEE2E2',
            padding: '1rem',
            borderRadius: '8px',
            color: '#DC2626',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('sessions.create.title')}</h2>
              <button className="btn-icon" onClick={() => setShowCreateModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('sessions.create.label')}</label>
              <input
                type="text"
                placeholder={t('sessions.create.placeholder')}
                value={newSessionName}
                onChange={e => {
                  const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
                  setNewSessionName(value);
                }}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
              <p className="input-hint">
                <Trans i18nKey="sessions.create.hint" components={{ code: <code /> }} />
              </p>
              {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
                <p className="input-error">{t('sessions.create.invalidChars')}</p>
              )}
              {newSessionName && newSessionName.length > 50 && (
                <p className="input-error">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
              )}
              {newSessionName &&
                /^[a-z0-9-]+$/.test(newSessionName) &&
                newSessionName.length <= 50 &&
                sessions.some(s => s.name === newSessionName) && (
                  <p className="input-error">{t('sessions.create.duplicate')}</p>
                )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={
                  creating ||
                  !newSessionName.trim() ||
                  !/^[a-z0-9-]+$/.test(newSessionName) ||
                  newSessionName.length > 50 ||
                  sessions.some(s => s.name === newSessionName)
                }
              >
                {creating ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {qrData && (
        <div className="modal-overlay" onClick={() => setQrData(null)}>
          <div className="modal qr-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>{t('sessions.qr.title')}</h2>
                <span className="session-name">{qrData.sessionName}</span>
              </div>
              <button className="btn-close" onClick={() => setQrData(null)} aria-label={t('common.close')}>
                <X size={20} color="#64748b" />
              </button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              {qrData.connected ? (
                <div className="qr-success">
                  <div className="qr-success-ring">
                    <svg className="qr-success-check" viewBox="0 0 52 52" aria-hidden="true">
                      <circle className="qr-success-circle" cx="26" cy="26" r="24" />
                      <path className="qr-success-tick" d="M14 27 l8 8 l16 -16" />
                    </svg>
                  </div>
                  <h3 className="qr-success-title">{t('sessions.qr.connectedTitle')}</h3>
                  <p className="qr-success-desc">{t('sessions.qr.connectedDesc')}</p>
                </div>
              ) : qrData.qrCode ? (
                <>
                  <img src={qrData.qrCode} alt="QR" style={{ maxWidth: '280px', borderRadius: '12px' }} />
                  <div className="qr-instructions">
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step1" components={{ strong: <strong /> }} /></p>
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step2" components={{ strong: <strong /> }} /></p>
                    <p className="qr-step"><Trans i18nKey="sessions.qr.step3" components={{ strong: <strong /> }} /></p>
                  </div>
                  <p className="qr-auto-refresh">
                    <RefreshCw size={14} className="spin-slow" /> {t('sessions.qr.autoRefresh')}
                  </p>
                </>
              ) : (
                <div style={{ padding: '2rem' }}>
                  <Loader2 className="animate-spin" size={48} />
                  <p>{t('sessions.qr.generating')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('sessions.details.title')}</h2>
              <button className="btn-icon" onClick={() => setSelectedSession(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.name')}</span>
                  <span className="detail-value">{selectedSession.name}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.status')}</span>
                  <span className={`status-badge ${selectedSession.status}`}>{formatStatus(selectedSession.status)}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.sessionId')}</span>
                  <span className="detail-value mono">{selectedSession.id}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.phone')}</span>
                  <span className="detail-value">{selectedSession.phone || t('sessions.details.phoneNone')}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.created')}</span>
                  <span className="detail-value">{new Date(selectedSession.createdAt).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">{t('sessions.details.lastActive')}</span>
                  <span className="detail-value">
                    {selectedSession.lastActive ? new Date(selectedSession.lastActive).toLocaleString() : t('common.never')}
                  </span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSelectedSession(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmId(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('sessions.delete.title')}</h2>
              <button className="btn-icon" onClick={() => setDeleteConfirmId(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>
                <Trans
                  i18nKey="sessions.delete.message"
                  values={{ name: sessions.find(s => s.id === deleteConfirmId)?.name }}
                  components={{ strong: <strong /> }}
                />
              </p>
              <p className="text-muted">{t('sessions.delete.warning')}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteConfirmId(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => handleDelete(deleteConfirmId)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <QrCode size={48} />
            <h3>{t('sessions.empty.title')}</h3>
            <p>{t('sessions.empty.description')}</p>
          </div>
        ) : (
          filteredSessions.map(session => (
            <div key={session.id} className="session-card">
              <div className="card-header">
                <h3 title={session.name}>{session.name}</h3>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
              </div>

              {session.status === 'initializing' || session.status === 'connecting' || session.status === 'qr_ready' ? (
                <div className="qr-placeholder">
                  <QrCode size={80} className="qr-icon" />
                  <p>{session.status === 'qr_ready' ? t('sessions.qr.scanToConnect') : t('sessions.qr.preparing')}</p>
                  <button
                    className="btn-sm"
                    onClick={() => handleShowQR(session.id)}
                    disabled={session.status !== 'qr_ready'}
                  >
                    {session.status === 'qr_ready' ? t('sessions.qr.showQr') : t('sessions.qr.loading')}
                  </button>
                </div>
              ) : (
                <div className="session-info">
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.phone')}</span>
                    <span className="info-value">{session.phone || '—'}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.sessionId')}</span>
                    <span className="info-value mono">{session.id.substring(0, 12)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.lastActive')}</span>
                    <span className="info-value">{formatLastActive(session.lastActive)}</span>
                  </div>
                </div>
              )}

              <div className="card-actions">
                <button className="btn-action" onClick={() => setSelectedSession(session)}>
                  <Eye size={16} />
                  {t('sessions.actions.view')}
                </button>
                {canWrite &&
                (session.status === 'created' || session.status === 'idle' || session.status === 'disconnected') ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <Play size={16} />
                    {t('sessions.actions.start')}
                  </button>
                ) : canWrite && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) ? (
                  <button className="btn-action" onClick={() => handleStop(session.id)}>
                    <Square size={16} />
                    {t('sessions.actions.stop')}
                  </button>
                ) : canWrite ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <RefreshCw size={16} />
                    {t('sessions.actions.reconnect')}
                  </button>
                ) : null}
                {canWrite && (
                  <button className="btn-action danger" onClick={() => setDeleteConfirmId(session.id)}>
                    <Trash2 size={16} />
                    {t('sessions.actions.delete')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
