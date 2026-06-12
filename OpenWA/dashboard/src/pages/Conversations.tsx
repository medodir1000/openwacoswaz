// Conversations — a WhatsApp-commerce inbox for the seller, modelled on
// the competitor's 3-pane layout: conversation list (search + filter
// tabs) · chat thread (date separators, bubbles, composer) · customer
// panel (readiness, agent insights, timeline).
//
// Talks to brain.py through /funnel/conversations* (Vite proxy → :5001).
// The LIST works against the existing endpoint immediately; the thread
// view / send / take-over routes are newer — if the brain hasn't been
// restarted yet they 404 and the center pane shows a friendly notice.
import {
  useEffect, useMemo, useRef, useState, useCallback,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, Send, Bot, Loader2, RefreshCw, Sparkles, Clock,
  MessagesSquare, Phone, Plus, AlertCircle, CheckCheck, Hand, Play,
} from 'lucide-react';
import { useServiceConfig } from '../hooks/useServiceConfig';
import { useActiveSession, matchesSession } from '../hooks/useActiveSession';
import './Conversations.css';

// ── Types (mirror brain's decorated rows) ─────────────────────────────────
type Readiness = { level: number; stage: string };

type ConversationRow = {
  id: string;
  customer_jid: string;
  customer_phone: string | null;
  country_code: string | null;
  language_code: string | null;
  status: string;
  started_at: string;
  last_message_at: string;
  pending_order_fields: Record<string, unknown> | null;
  // Derived server-side (absent on pre-restart brain → guard everywhere).
  customer_name?: string;
  agent_paused?: boolean;
  readiness?: Readiness;
  last_message?: string;
  last_message_role?: string;
  // Session pins resolved from the conversation's detected product, so the
  // global session switcher can scope the inbox to one WhatsApp number.
  // Empty when no product detected yet → shows only under "All sessions".
  session_jids?: string[];
};

type Message = {
  id: string;
  role: string;            // 'user' (customer) | 'assistant' (bot/operator)
  content: string;
  created_at: string;
};

type Filter = 'all' | 'ai' | 'human' | 'unpaid';

// Every /funnel/* call carries the seller id stashed at login so the
// brain scopes the read/write to the right tenant.
async function ffetch(path: string, init: RequestInit = {}) {
  const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  if (sellerId && !headers['X-Seller-Id']) headers['X-Seller-Id'] = sellerId;
  return fetch(path, { ...init, headers });
}

// ── Small presentational helpers ──────────────────────────────────────────
const AVATAR_COLORS = [
  '#25d366', '#3b5cf6', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#ef4444', '#10b981', '#f97316', '#6366f1',
];
function seedColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string, phone: string): string {
  const n = (name || '').trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    return (parts[0]?.[0] || '').concat(parts[1]?.[0] || '').toUpperCase() || n[0].toUpperCase();
  }
  const p = (phone || '').replace(/\D+/g, '');
  return p.slice(-2) || '?';
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function Conversations() {
  const { t, i18n } = useTranslation();
  // Vertical-aware terminology for the customer panel + agent-insights
  // heading (an e-commerce "Customer" reads as "Patient" for a clinic,
  // "Guest" for a hotel, "Sales insights" → "Booking insights", etc.).
  const { config, label } = useServiceConfig();
  // Global "which WhatsApp number am I viewing?" scope from the top-bar
  // switcher. null = "All sessions" (no filter).
  const { activeSessionId } = useActiveSession();

  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [listError, setListError] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ conversation: ConversationRow; messages: Message[] } | null>(null);
  const [threadError, setThreadError] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);

  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Relative time + clock formatters (locale-aware where it matters) ──
  const relTime = useCallback((iso: string): string => {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Math.max(0, Date.now() - then);
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('conversations.justNow', 'now');
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(iso).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' });
  }, [t, i18n.language]);

  const clock = useCallback((iso: string): string => {
    if (!iso) return '';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  }, [i18n.language]);

  const dayLabel = useCallback((iso: string): string => {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(dt, today)) return t('conversations.today', 'Today');
    if (same(dt, y)) return t('conversations.yesterday', 'Yesterday');
    return dt.toLocaleDateString(i18n.language, { day: '2-digit', month: 'short', year: 'numeric' });
  }, [t, i18n.language]);

  // ── Fetch the conversation list (polled) ──
  const loadList = useCallback(async () => {
    try {
      const res = await ffetch('/funnel/conversations');
      if (!res.ok) { setListError(true); return; }
      const data = await res.json();
      setRows(Array.isArray(data.conversations) ? data.conversations : []);
      setListError(false);
    } catch {
      setListError(true);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
    const id = setInterval(() => void loadList(), 10_000);
    return () => clearInterval(id);
  }, [loadList]);

  // ── Fetch one thread (polled while open) ──
  const loadThread = useCallback(async (cid: string, showSpinner = false) => {
    if (showSpinner) setLoadingThread(true);
    try {
      const res = await ffetch(`/funnel/conversations/${cid}/messages`);
      if (!res.ok) { setThreadError(true); setThread(null); return; }
      const data = await res.json();
      setThread({
        conversation: data.conversation as ConversationRow,
        messages: Array.isArray(data.messages) ? data.messages : [],
      });
      setThreadError(false);
    } catch {
      setThreadError(true);
    } finally {
      if (showSpinner) setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setThread(null); return; }
    setThreadError(false);
    void loadThread(selectedId, true);
    const id = setInterval(() => void loadThread(selectedId), 5_000);
    return () => clearInterval(id);
  }, [selectedId, loadThread]);

  // Auto-scroll the thread to the newest message.
  const msgCount = thread?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, selectedId]);

  // ── Derived: filtered + searched list ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // Global session scope first: a conversation inherits its detected
      // product's session pins. emptyIsAll=false → an undetected chat
      // (no product yet) shows only under "All sessions", never under a
      // single number it can't be attributed to.
      if (!matchesSession(r.session_jids, activeSessionId, false)) return false;
      if (filter === 'ai' && r.agent_paused) return false;
      if (filter === 'human' && !r.agent_paused) return false;
      if (filter === 'unpaid' && (r.readiness?.level ?? 0) >= 4) return false;
      if (!q) return true;
      const hay = `${r.customer_name || ''} ${r.customer_phone || ''} ${r.customer_jid || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter, search, activeSessionId]);

  // The header / right-panel prefer the freshly-fetched thread row, then
  // fall back to the list row (so selecting feels instant).
  const listRow = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId],
  );
  const active: ConversationRow | null = thread?.conversation || listRow;

  const stageKey = active?.readiness?.stage || 'new';
  const stageLabel = t(`conversations.stageLabel.${stageKey}`, stageKey);
  const level = active?.readiness?.level ?? 0;
  const phone = active?.customer_phone || active?.customer_jid?.split('@')[0] || '';
  const displayName = active?.customer_name || phone || label(config.customer.singular);
  const paused = !!active?.agent_paused;

  // A short, editable French draft reply keyed to the funnel stage — the
  // dominant customer language for codhelix's market. Operator edits
  // before sending. Mirrors the competitor's "Suggestion → + Add to
  // message" affordance.
  const suggestionDraft = useMemo(() => {
    switch (stageKey) {
      case 'browsing':   return 'Souhaitez-vous que je vous envoie plus de détails ou des photos ? 📸';
      case 'collecting': return 'Pour finaliser, j’ai besoin de votre nom, la quantité et votre adresse de livraison 🙏';
      case 'confirming': return 'Je confirme votre commande ✅ Pouvez-vous me donner l’adresse exacte de livraison ?';
      case 'ordered':    return 'Merci pour votre commande ! 🎉 Nous vous contactons très vite pour la livraison.';
      default:           return 'Bonjour 👋 Quel produit vous intéresse aujourd’hui ?';
    }
  }, [stageKey]);

  // ── Actions ──
  const doSend = useCallback(async () => {
    const text = composer.trim();
    if (!text || !selectedId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await ffetch(`/funnel/conversations/${selectedId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        setSendError(
          res.status === 404
            ? t('conversations.loadError', 'Couldn’t reach this thread. If you just updated the bot, restart the brain.')
            : t('conversations.sendError', 'Message couldn’t be sent. Check the WhatsApp session.'),
        );
        return;
      }
      setComposer('');
      await loadThread(selectedId);
      await loadList();
    } catch {
      setSendError(t('conversations.sendError', 'Message couldn’t be sent. Check the WhatsApp session.'));
    } finally {
      setSending(false);
    }
  }, [composer, selectedId, sending, t, loadThread, loadList]);

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  const toggleAgent = useCallback(async () => {
    if (!selectedId || agentBusy) return;
    setAgentBusy(true);
    const next = !paused;
    try {
      const res = await ffetch(`/funnel/conversations/${selectedId}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      if (res.ok) {
        await loadThread(selectedId);
        await loadList();
      } else {
        setSendError(
          res.status === 404
            ? t('conversations.loadError', 'Couldn’t reach this thread. If you just updated the bot, restart the brain.')
            : t('conversations.sendError', 'Action failed. Try again.'),
        );
      }
    } catch {
      setSendError(t('conversations.sendError', 'Action failed. Try again.'));
    } finally {
      setAgentBusy(false);
    }
  }, [selectedId, agentBusy, paused, t, loadThread, loadList]);

  const addSuggestion = () => {
    setComposer((c) => (c ? `${c} ${suggestionDraft}` : suggestionDraft));
    composerRef.current?.focus();
  };

  // Group messages into day-separated blocks for the thread render.
  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = [];
    for (const m of thread?.messages ?? []) {
      const day = dayLabel(m.created_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [thread?.messages, dayLabel]);

  // ── Render ──
  return (
    <div className="conv-page">
      {/* ── Left: conversation list ── */}
      <aside className="conv-list">
        <div className="conv-list-head">
          <h2 className="conv-title">
            <MessagesSquare size={18} />
            {t('conversations.title', 'Conversations')}
          </h2>
          <button className="conv-icon-btn" onClick={() => void loadList()} title={t('common.refresh', 'Refresh')}>
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="conv-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('conversations.searchPlaceholder', 'Search by name or number…')}
          />
        </div>

        <div className="conv-filters">
          {(['all', 'ai', 'human', 'unpaid'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`conv-filter ${filter === f ? 'is-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {t(`conversations.filter.${f}`, f)}
            </button>
          ))}
        </div>

        <div className="conv-rows">
          {loadingList ? (
            <div className="conv-empty"><Loader2 className="spin" size={20} /></div>
          ) : listError ? (
            <div className="conv-empty">
              <AlertCircle size={18} />
              <p>{t('conversations.listError', 'Couldn’t load conversations.')}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="conv-empty">
              <MessagesSquare size={22} />
              <p>{t('conversations.empty', 'No conversations yet')}</p>
              <span>{t('conversations.emptyHint', 'Incoming WhatsApp chats will show up here.')}</span>
            </div>
          ) : (
            filtered.map((r) => {
              const name = r.customer_name || r.customer_phone || r.customer_jid?.split('@')[0] || '—';
              const preview = r.last_message || '';
              const isCust = r.last_message_role === 'user';
              return (
                <button
                  key={r.id}
                  className={`conv-row ${selectedId === r.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span className="conv-avatar" style={{ background: seedColor(r.customer_jid || r.id) }}>
                    {initials(r.customer_name || '', r.customer_phone || r.customer_jid || '')}
                  </span>
                  <span className="conv-row-body">
                    <span className="conv-row-top">
                      <span className="conv-row-name">{name}</span>
                      <span className="conv-row-time">{relTime(r.last_message_at)}</span>
                    </span>
                    <span className="conv-row-bottom">
                      <span className="conv-row-preview">
                        {preview ? (isCust ? '' : '↩ ') + preview : t('conversations.noMessages', 'No messages')}
                      </span>
                      {r.agent_paused
                        ? <span className="conv-tag human"><Hand size={11} /></span>
                        : <span className="conv-tag ai"><Bot size={11} /></span>}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Center: chat thread ── */}
      <section className="conv-thread">
        {!selectedId ? (
          <div className="conv-thread-empty">
            <MessagesSquare size={40} />
            <p>{t('conversations.selectPrompt', 'Select a conversation to view the thread')}</p>
          </div>
        ) : (
          <>
            <header className="conv-thread-head">
              <span className="conv-avatar sm" style={{ background: seedColor(active?.customer_jid || selectedId) }}>
                {initials(active?.customer_name || '', phone)}
              </span>
              <div className="conv-thread-id">
                <strong>{displayName}</strong>
                <span>{phone}</span>
              </div>
              <div className="conv-thread-actions">
                <span className={`conv-agent-state ${paused ? 'off' : 'on'}`}>
                  <Bot size={13} />
                  {paused ? t('conversations.agentOff', 'Agent OFF') : t('conversations.agentOn', 'Agent ON')}
                </span>
                <button
                  className={`conv-btn ${paused ? 'primary' : 'ghost'}`}
                  onClick={() => void toggleAgent()}
                  disabled={agentBusy}
                >
                  {agentBusy ? <Loader2 className="spin" size={14} />
                    : paused ? <><Play size={14} />{t('conversations.resumeBot', 'Resume bot')}</>
                    : <><Hand size={14} />{t('conversations.takeOver', 'Take over')}</>}
                </button>
              </div>
            </header>

            <div className="conv-messages" ref={scrollRef}>
              {loadingThread ? (
                <div className="conv-empty"><Loader2 className="spin" size={20} /></div>
              ) : threadError ? (
                <div className="conv-empty">
                  <AlertCircle size={18} />
                  <p>{t('conversations.loadError', 'Couldn’t load this thread. If you just updated the bot, restart the brain to enable live threads.')}</p>
                </div>
              ) : grouped.length === 0 ? (
                <div className="conv-empty"><p>{t('conversations.noMessages', 'No messages')}</p></div>
              ) : (
                grouped.map((block) => (
                  <div key={block.day} className="conv-day-block">
                    <div className="conv-day-sep"><span>{block.day}</span></div>
                    {block.items.map((m) => {
                      const mine = m.role !== 'user';
                      // The bot mirrors every photo it sends into the thread as
                      // an [[image:URL]] marker so the seller sees it. Render
                      // those as an actual (clickable) image instead of text.
                      const img = /^\[\[image:(.+)\]\]$/.exec((m.content || '').trim());
                      return (
                        <div key={m.id} className={`conv-bubble-row ${mine ? 'mine' : 'theirs'}`}>
                          <div className={`conv-bubble ${img ? 'is-image' : ''}`}>
                            {img ? (
                              <a className="conv-bubble-img" href={img[1]} target="_blank" rel="noreferrer">
                                <img src={img[1]} alt="" loading="lazy" />
                              </a>
                            ) : (
                              <p>{m.content}</p>
                            )}
                            <span className="conv-bubble-meta">
                              {clock(m.created_at)}
                              {mine && <CheckCheck size={13} className="conv-receipt" />}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {sendError && (
              <div className="conv-send-error"><AlertCircle size={14} />{sendError}</div>
            )}
            {paused && !threadError && (
              <div className="conv-takeover-note"><Hand size={13} />{t('conversations.humanControlled', 'You’re handling this chat — the bot is paused.')}</div>
            )}

            <div className="conv-composer">
              <textarea
                ref={composerRef}
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={onComposerKey}
                rows={1}
                placeholder={t('conversations.composerPlaceholder', 'Send a message as admin…')}
              />
              <button className="conv-send-btn" onClick={() => void doSend()} disabled={sending || !composer.trim()}>
                {sending ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── Right: customer panel ── */}
      {selectedId && active && (
        <aside className="conv-panel">
          <div className="conv-card">
            <span className="conv-avatar lg" style={{ background: seedColor(active.customer_jid || selectedId) }}>
              {initials(active.customer_name || '', phone)}
            </span>
            <strong className="conv-card-name">{displayName}</strong>
            <span className="conv-card-phone"><Phone size={12} />{phone}</span>
            <div className="conv-badges">
              <span className={`conv-readiness lvl-${level}`}>{t('conversations.readiness', 'Readiness lvl {{level}}', { level })}</span>
              <span className="conv-stage">{t('conversations.stage', 'stage: {{stage}}', { stage: stageLabel })}</span>
            </div>
          </div>

          <div className="conv-section">
            <h3><Sparkles size={14} />{label(config.insightsTitle)}</h3>
            <p className="conv-section-hint">{label(config.insightsHint)}</p>
            <div className="conv-suggestion">
              <span className="conv-suggestion-label">{t('conversations.suggestion', 'Suggestion')}</span>
              <p>{suggestionDraft}</p>
              <button className="conv-add-suggestion" onClick={addSuggestion}>
                <Plus size={13} />{t('conversations.addToMessage', 'Add to message')}
              </button>
            </div>
          </div>

          <div className="conv-section">
            <h3><Clock size={14} />{t('conversations.timeline', 'Timeline')}</h3>
            <ul className="conv-timeline">
              <li>
                <span className="conv-dot" />
                <div>
                  <strong>{t('conversations.timelineStage', 'Stage: {{stage}}', { stage: stageLabel })}</strong>
                  <span>{relTime(active.last_message_at)}</span>
                </div>
              </li>
              <li>
                <span className="conv-dot muted" />
                <div>
                  <strong>{t('conversations.timelineStarted', 'Conversation started')}</strong>
                  <span>{active.started_at ? new Date(active.started_at).toLocaleString(i18n.language) : ''}</span>
                </div>
              </li>
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
