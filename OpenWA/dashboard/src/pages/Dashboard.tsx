import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare, UserPlus, Target, ShoppingBag, Send, Inbox, Zap,
  ArrowUpRight, ArrowDownRight, Loader2, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery, useSessionStatsQuery, useStopSessionMutation } from '../hooks/queries';
import { useServiceConfig } from '../hooks/useServiceConfig';
import { useOrganization, PLAN_LABELS } from '../hooks/useOrganization';
import type { OrderStatus } from '../config/serviceConfig';
import { PageHeader } from '../components/PageHeader';
import './Dashboard.css';

type SeriesPoint = { date: string; conversations: number; orders: number };

// Mirror of /funnel/stats/dashboard. Every field beyond the first four is
// optional so an older brain (pre-redesign payload) degrades gracefully —
// the cards fall back to 0 / em-dash rather than crash.
type FunnelStats = {
  messages_today: number;
  api_calls_24h: number;
  orders_today: number;
  conversations_active: number;
  conversations_total?: number;
  new_contacts_7d?: number;
  new_contacts_prev_7d?: number;
  resolution_rate?: number;
  order_placed_total?: number;
  conversations_sampled?: number;
  conversions_total?: number;
  conversions_7d?: number;
  conversions_prev_7d?: number;
  channels?: Record<string, number>;
  messages_sent?: number;
  messages_received?: number;
  response_rate?: number;
  series?: SeriesPoint[];
};

// Minimal shape of a /funnel/orders row — just what the activity feed needs.
type ActivityOrder = {
  id: string;
  created_at: string;
  status: string;
  customer_name: string | null;
  products: { name: string | null } | null;
};

// Closwiz purple-led KPI accents (one hue per card for instant scanning).
const ACCENT = {
  conversations: '#00C896',
  contacts: '#8B5CF6',
  resolution: '#06B6D4',
  conversions: '#F59E0B',
};
// Brand-true channel colours; unknown order sources fall back to grey.
const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: '#25D366',
  shopify: '#95BF47',
};
const CHANNEL_FALLBACK = '#9CA3AF';

// % change of `curr` vs `prev`. up=null means "no movement / no baseline"
// so the card can hide the arrow rather than show a misleading 0%.
function trend(curr: number, prev: number): { pct: number; up: boolean | null } {
  if (!prev && !curr) return { pct: 0, up: null };
  if (!prev) return { pct: 100, up: true };
  const pct = Math.round(((curr - prev) / prev) * 100);
  return { pct: Math.abs(pct), up: pct >= 0 };
}

// Build an SVG path "M..L.." from [x,y] points.
function linePath(pts: ReadonlyArray<readonly [number, number]>): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

// ── Tiny sparkline (area + line) for the KPI cards ──────────────────────
function Sparkline({ data, color, gradId }: { data: number[]; color: string; gradId: string }) {
  const w = 100, h = 30, pad = 2;
  if (data.length < 2) return <div className="spark-empty" />;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => [
    pad + i * step,
    h - pad - ((v - min) / range) * (h - pad * 2),
  ] as const);
  const line = linePath(pts);
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Slim progress bar (resolution rate / response rate) ─────────────────
function ProgressBar({ value, color }: { value: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

type KpiCardProps = {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: string;
  trendInfo?: { pct: number; up: boolean | null; caption: string } | null;
  spark?: { data: number[]; gradId: string } | null;
  progress?: number | null;
  sub?: string | null;
};

function KpiCard({ label, value, icon: Icon, accent, trendInfo, spark, progress, sub }: KpiCardProps) {
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <div className="kpi-meta">
          <span className="kpi-label">{label}</span>
          <span className="kpi-value">{value}</span>
        </div>
        <span className="kpi-icon" style={{ background: `${accent}1a`, color: accent }}>
          <Icon size={20} />
        </span>
      </div>

      {trendInfo && trendInfo.up !== null && (
        <div className={`kpi-trend ${trendInfo.up ? 'up' : 'down'}`}>
          {trendInfo.up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          <span>{trendInfo.pct}%</span>
          <span className="kpi-trend-caption">{trendInfo.caption}</span>
        </div>
      )}
      {sub && <div className="kpi-sub">{sub}</div>}

      <div className="kpi-foot">
        {progress != null
          ? <ProgressBar value={progress} color={accent} />
          : spark
            ? <Sparkline data={spark.data} color={accent} gradId={spark.gradId} />
            : null}
      </div>
    </div>
  );
}

// ── Conversations / orders area chart (14-day window) ───────────────────
function AreaChart({
  series, convoColor, orderColor, fmtTick,
}: {
  series: SeriesPoint[];
  convoColor: string;
  orderColor: string;
  fmtTick: (iso: string) => string;
}) {
  const w = 560, h = 220, padL = 10, padR = 10, padT = 16, padB = 26;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const convo = series.map(s => s.conversations);
  const orders = series.map(s => s.orders);
  const max = Math.max(...convo, ...orders, 1);
  const stepX = innerW / Math.max(series.length - 1, 1);
  const project = (arr: number[]) =>
    arr.map((v, i) => [padL + i * stepX, padT + innerH - (v / max) * innerH] as const);

  const convoPts = project(convo);
  const orderPts = project(orders);
  const convoLine = linePath(convoPts);
  const convoArea = `${convoLine} L${convoPts[convoPts.length - 1][0].toFixed(1)},${(padT + innerH).toFixed(1)} L${convoPts[0][0].toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // 3 horizontal gridlines (incl. baseline) + a tick roughly every ~6 days.
  const grid = [0, 0.5, 1].map(f => padT + innerH - f * innerH);
  const tickEvery = Math.ceil(series.length / 6);

  return (
    <svg className="area-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="chart">
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={convoColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={convoColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid.map((y, i) => (
        <line key={i} className="grid-line" x1={padL} y1={y} x2={w - padR} y2={y} />
      ))}
      <path d={convoArea} fill="url(#areaFill)" />
      <path d={convoLine} fill="none" stroke={convoColor} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <path d={linePath(orderPts)} fill="none" stroke={orderColor} strokeWidth="2" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" />
      {convoPts.map(([x, y], i) =>
        i % tickEvery === 0 || i === series.length - 1 ? (
          <circle key={`c${i}`} cx={x} cy={y} r="2.5" fill={convoColor} />
        ) : null,
      )}
      {series.map((s, i) =>
        i % tickEvery === 0 || i === series.length - 1 ? (
          <text key={`t${i}`} className="x-label" x={padL + i * stepX} y={h - 8} textAnchor="middle">
            {fmtTick(s.date)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

// ── Channels donut ──────────────────────────────────────────────────────
function Donut({ segments, total, centerLabel }: {
  segments: { key: string; label: string; value: number; color: string }[];
  total: number;
  centerLabel: string;
}) {
  const size = 168, stroke = 22, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const cx = size / 2;
  let acc = 0;
  return (
    <div className="donut-wrap">
      <svg className="donut" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="donut">
        <circle className="donut-bg" cx={cx} cy={cx} r={r} strokeWidth={stroke} fill="none" />
        {total > 0 && segments.map(seg => {
          const frac = seg.value / total;
          const dash = frac * circ;
          const el = (
            <circle
              key={seg.key}
              cx={cx} cy={cx} r={r} fill="none"
              stroke={seg.color} strokeWidth={stroke}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-acc}
              transform={`rotate(-90 ${cx} ${cx})`}
              strokeLinecap="butt"
            />
          );
          acc += dash;
          return el;
        })}
        <text className="donut-total" x={cx} y={cx - 2} textAnchor="middle">{total.toLocaleString()}</text>
        <text className="donut-cap" x={cx} y={cx + 16} textAnchor="middle">{centerLabel}</text>
      </svg>
      <ul className="donut-legend">
        {segments.map(seg => (
          <li key={seg.key}>
            <span className="legend-dot" style={{ background: seg.color }} />
            <span className="legend-label">{seg.label}</span>
            <span className="legend-val">
              {seg.value.toLocaleString()}
              <span className="legend-pct">{total ? ` · ${Math.round((seg.value / total) * 100)}%` : ''}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Dashboard() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const { data: stats } = useSessionStatsQuery();
  const stopMutation = useStopSessionMutation();

  // Vertical-aware vocabulary for the trends + live-activity feed. `config`
  // carries localized nouns/templates, `label` resolves them to the active
  // language, and `fill` interpolates {customer}/{product} placeholders.
  const { config, label, fill } = useServiceConfig();

  // Billing/trial snapshot (polls /funnel/billing/usage every 30s). Drives
  // the plan-status banner below the page header. Lives outside the query
  // client so it shares the same plain-fetch path the top bar uses.
  const org = useOrganization();

  // Brain-side analytics. Polled every 30s, scoped by X-Seller-Id (stashed
  // at login). On failure the cards keep their last-known values.
  const [funnelStats, setFunnelStats] = useState<FunnelStats | null>(null);
  useEffect(() => {
    const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
    if (!sellerId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/funnel/stats/dashboard', { headers: { 'X-Seller-Id': sellerId } });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setFunnelStats(j as FunnelStats);
      } catch {
        /* swallow — cards stay at last-known */
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Recent activity — last handful of orders, relabeled for the seller's
  // vertical. Shares the 30s cadence so the feed stays roughly live.
  const [recentOrders, setRecentOrders] = useState<ActivityOrder[]>([]);
  useEffect(() => {
    const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
    if (!sellerId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/funnel/orders', { headers: { 'X-Seller-Id': sellerId } });
        if (!r.ok) return;
        const j = await r.json();
        const rows = Array.isArray(j.orders) ? (j.orders as ActivityOrder[]) : [];
        if (!cancelled) setRecentOrders(rows.slice(0, 6));
      } catch {
        /* swallow — feed stays at last-known */
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const loading = loadingSessions;
  const error = sessionsError instanceof Error
    ? sessionsError.message
    : sessionsError ? t('dashboard.loadError') : null;

  const handleDisconnect = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
  };

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.hoursAgo', { count: Math.floor(diff / 3600000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const orderStatusLabel = (status: string): string => {
    const entry = config.statusLabels[status as OrderStatus];
    return entry ? label(entry) : status;
  };

  const activityLine = (o: ActivityOrder): string => {
    const customer = o.customer_name?.trim() || t('dashboard.activity.someone', 'Someone');
    const product = o.products?.name?.trim() || label(config.product.singular).toLowerCase();
    const template = ['confirmed', 'dispatched', 'delivered'].includes(o.status)
      ? config.activity.confirmed
      : config.activity.newOrder;
    return fill(template, { customer, product });
  };

  if (loading) {
    return (
      <div className="dashboard" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard" style={{ padding: '2rem' }}>
        <div style={{ background: '#FEE2E2', padding: '1rem', borderRadius: '8px', color: '#DC2626' }}>
          {t('dashboard.errorPrefix', { message: error })}
        </div>
      </div>
    );
  }

  // ── Derive the view-model from the (possibly partial) payload ──────────
  const fs = funnelStats;
  const series = fs?.series ?? [];
  const hasSeries = series.length > 0;
  const convoSeries = series.map(s => s.conversations);
  const orderSeries = series.map(s => s.orders);
  // Card 1 sparkline: cumulative new conversations across the window — a
  // rising line that reads as "total growing", distinct from the spiky
  // daily series the other cards show.
  const convoCumulative = convoSeries.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] ?? 0) + v);
    return acc;
  }, []);

  const newContactsTrend = trend(fs?.new_contacts_7d ?? 0, fs?.new_contacts_prev_7d ?? 0);
  const conversionsTrend = trend(fs?.conversions_7d ?? 0, fs?.conversions_prev_7d ?? 0);
  const resolutionPct = Math.round((fs?.resolution_rate ?? 0) * 100);
  const responsePct = Math.round((fs?.response_rate ?? 0) * 100);
  const vsCaption = t('dashboard.kpi.vsPrevWeek');

  const dash = '—';
  const num = (v: number | undefined) => (fs && v != null ? v.toLocaleString() : dash);

  // Channels donut segments (brand colours; unknown sources kept verbatim).
  const channelEntries = Object.entries(fs?.channels ?? {});
  const channelTotal = channelEntries.reduce((sum, [, v]) => sum + v, 0);
  const channelSegments = channelEntries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({
      key,
      value,
      label: t(`dashboard.channels.${key}`, { defaultValue: key }),
      color: CHANNEL_COLORS[key] ?? CHANNEL_FALLBACK,
    }));

  const fmtTick = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
  };
  const orderLegendLabel = label(config.order.plural);

  // ── Plan / trial status banner ────────────────────────────────────────
  // Honest snapshot from the billing brain (useOrganization → /funnel/
  // billing/usage). Self-serve trial signups (is_trial=true) get a live
  // 2-day / 30-conversation countdown; free + paid sellers see their plan,
  // real conversation volume and monthly fair-use. We never fabricate a
  // countdown for non-trial accounts — legacy + paid sellers carry
  // is_trial=false, so they get "no time limit" / "until renewal" framing.
  const planIsPaid = !org.is_trial && org.plan !== 'free';
  const planName = org.is_trial
    ? t('billing.tier.trial', 'Free trial')
    : org.plan === 'free'
      ? t('dashboard.plan.free', 'Free')
      : PLAN_LABELS[org.plan];
  const planTrialCap = org.trial_conversations_cap || 30;
  const planTrialUsed = Math.min(org.trial_conversations_used, planTrialCap);
  const planTrialPct = planTrialCap > 0
    ? Math.min(100, Math.round((100 * org.trial_conversations_used) / planTrialCap))
    : 0;
  const planTrialEnded = org.is_trial
    && (org.trial_days_left <= 0 || org.trial_conversations_used >= planTrialCap);
  const planTrialWarn = org.is_trial && !planTrialEnded
    && (org.trial_days_left <= 1 || planTrialPct >= 80);
  const planConversations = fs?.conversations_total ?? 0;
  const planBarPct = org.is_trial
    ? planTrialPct
    : Math.min(100, Math.max(0, Math.round(org.fair_use_percent)));

  return (
    <div className="dashboard">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        badge={
          <span className={`status-badge ${stats && stats.ready > 0 ? 'connected' : 'disconnected'}`}>
            {stats && stats.ready > 0 ? t('common.connected') : t('common.disconnected')}
          </span>
        }
      />

      <section
        className={`panel plan-status${org.is_trial ? ' is-trial' : ''}${
          planTrialEnded ? ' is-ended' : planTrialWarn ? ' is-warn' : ''
        }`}
      >
        <div className="plan-status-head">
          <span className="plan-status-icon">
            {org.is_trial ? <Sparkles size={20} /> : <Zap size={20} />}
          </span>
          <div className="plan-status-titles">
            <span className="plan-status-eyebrow">{t('dashboard.plan.eyebrow', 'Your plan')}</span>
            <div className="plan-status-name-row">
              <span className="plan-status-name">{planName}</span>
              {org.is_trial && (
                <span className="plan-status-tag">
                  {planTrialEnded
                    ? t('dashboard.plan.trialEnded', 'Trial ended')
                    : t('dashboard.plan.trialTag', 'Trial')}
                </span>
              )}
            </div>
            <span className="plan-status-sub">
              {org.is_trial
                ? t('dashboard.plan.trialSub', 'Full bot · 1 WhatsApp session, no feature locks')
                : planIsPaid
                  ? t('dashboard.plan.paidSub', '{{count}} WhatsApp sessions included', { count: org.sessions_included })
                  : t('dashboard.plan.freeSub', '1 WhatsApp session · upgrade to lift the limits')}
            </span>
          </div>
          <button type="button" className="plan-status-cta" onClick={() => navigate('/billing')}>
            {org.is_trial
              ? t('dashboard.plan.ctaTrial', 'Choose a plan')
              : planIsPaid
                ? t('dashboard.plan.ctaPaid', 'Manage plan')
                : t('dashboard.plan.ctaFree', 'Upgrade')}
            <ArrowUpRight size={15} />
          </button>
        </div>

        <div className="plan-status-metrics">
          <div className="plan-metric">
            <span className="plan-metric-value">
              {org.is_trial
                ? Math.max(0, org.trial_days_left)
                : planIsPaid
                  ? Math.max(0, org.days_to_renewal)
                  : '∞'}
            </span>
            <span className="plan-metric-label">
              {org.is_trial
                ? t('dashboard.plan.daysLeft', 'days left')
                : planIsPaid
                  ? t('dashboard.plan.untilRenewal', 'days until renewal')
                  : t('dashboard.plan.noExpiry', 'no time limit')}
            </span>
          </div>
          <div className="plan-metric">
            <span className="plan-metric-value">
              {org.is_trial ? `${planTrialUsed}/${planTrialCap}` : planConversations.toLocaleString()}
            </span>
            <span className="plan-metric-label">
              {org.is_trial
                ? t('dashboard.plan.conversationsUsed', 'conversations used')
                : t('dashboard.plan.conversationsHandled', 'conversations handled')}
            </span>
          </div>
        </div>

        <div className="plan-status-bar-row">
          <div className="plan-status-bar">
            <div className="plan-status-fill" style={{ width: `${planBarPct}%` }} />
          </div>
          <span className="plan-status-bar-label">
            {org.is_trial
              ? t('dashboard.plan.trialBar', '{{used}} of {{cap}} free conversations', { used: planTrialUsed, cap: planTrialCap })
              : t('dashboard.plan.fairUseBar', '{{pct}}% of monthly fair-use', { pct: planBarPct })}
          </span>
        </div>
      </section>

      <div className="kpi-grid">
        <KpiCard
          label={t('dashboard.kpi.conversations')}
          value={num(fs?.conversations_total)}
          icon={MessageSquare}
          accent={ACCENT.conversations}
          trendInfo={{ ...newContactsTrend, caption: vsCaption }}
          spark={hasSeries ? { data: convoCumulative, gradId: 'sp-conv' } : null}
        />
        <KpiCard
          label={t('dashboard.kpi.newContacts')}
          value={num(fs?.new_contacts_7d)}
          icon={UserPlus}
          accent={ACCENT.contacts}
          trendInfo={{ ...newContactsTrend, caption: vsCaption }}
          spark={hasSeries ? { data: convoSeries, gradId: 'sp-contacts' } : null}
        />
        <KpiCard
          label={t('dashboard.kpi.resolutionRate')}
          value={fs ? `${resolutionPct}%` : dash}
          icon={Target}
          accent={ACCENT.resolution}
          sub={fs ? t('dashboard.kpi.resolutionSub', {
            placed: (fs.order_placed_total ?? 0).toLocaleString(),
            total: (fs.conversations_sampled ?? 0).toLocaleString(),
          }) : null}
          progress={fs ? (fs.resolution_rate ?? 0) : null}
        />
        <KpiCard
          label={t('dashboard.kpi.conversions')}
          value={num(fs?.conversions_total)}
          icon={ShoppingBag}
          accent={ACCENT.conversions}
          trendInfo={{ ...conversionsTrend, caption: vsCaption }}
          spark={hasSeries ? { data: orderSeries, gradId: 'sp-conversions' } : null}
        />
      </div>

      <div className="dash-row">
        <section className="panel chart-panel">
          <div className="section-header">
            <div>
              <h2>{t('dashboard.charts.conversationsTitle')}</h2>
              <span className="section-subtitle">{t('dashboard.charts.conversationsSub')}</span>
            </div>
            <div className="chart-legend">
              <span className="legend-item"><i className="dot" style={{ background: ACCENT.conversations }} />{t('dashboard.charts.legendConversations')}</span>
              <span className="legend-item"><i className="dot dashed" style={{ background: ACCENT.conversions }} />{orderLegendLabel}</span>
            </div>
          </div>
          {hasSeries ? (
            <AreaChart series={series} convoColor={ACCENT.conversations} orderColor={ACCENT.conversions} fmtTick={fmtTick} />
          ) : (
            <div className="chart-empty">{t('dashboard.charts.noData')}</div>
          )}
        </section>

        <section className="panel donut-panel">
          <div className="section-header">
            <div>
              <h2>{t('dashboard.charts.channelsTitle')}</h2>
              <span className="section-subtitle">{t('dashboard.charts.channelsSub')}</span>
            </div>
          </div>
          {channelTotal > 0 ? (
            <Donut segments={channelSegments} total={channelTotal} centerLabel={orderLegendLabel} />
          ) : (
            <div className="chart-empty">{t('dashboard.charts.noData')}</div>
          )}
        </section>
      </div>

      <div className="dash-row">
        <section className="panel activity-panel">
          <div className="section-header">
            <div>
              <h2>{t('dashboard.recentActivity')}</h2>
              <span className="section-subtitle">{t('dashboard.recentActivitySubtitle')}</span>
            </div>
          </div>
          {recentOrders.length === 0 ? (
            <div className="activity-empty">{t('dashboard.noActivity')}</div>
          ) : (
            <div className="activity-feed">
              {recentOrders.map(o => (
                <div key={o.id} className="activity-item">
                  <span className="activity-icon"><Sparkles size={15} /></span>
                  <span className="activity-text">{activityLine(o)}</span>
                  <span className={`status-pill ${o.status}`}>{orderStatusLabel(o.status)}</span>
                  <span className="activity-time">{formatLastActive(o.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel botperf-panel">
          <div className="section-header">
            <div>
              <h2>{t('dashboard.botPerf.title')}</h2>
              <span className="section-subtitle">{t('dashboard.botPerf.window')}</span>
            </div>
          </div>
          <div className="perf-row">
            <span className="perf-icon" style={{ background: `${ACCENT.conversations}1a`, color: ACCENT.conversations }}><Send size={16} /></span>
            <span className="perf-label">{t('dashboard.botPerf.messagesSent')}</span>
            <span className="perf-val">{num(fs?.messages_sent)}</span>
          </div>
          <div className="perf-row">
            <span className="perf-icon" style={{ background: `${ACCENT.contacts}1a`, color: ACCENT.contacts }}><Inbox size={16} /></span>
            <span className="perf-label">{t('dashboard.botPerf.messagesReceived')}</span>
            <span className="perf-val">{num(fs?.messages_received)}</span>
          </div>
          <div className="perf-block">
            <div className="perf-block-head">
              <span className="perf-icon" style={{ background: `${ACCENT.resolution}1a`, color: ACCENT.resolution }}><Zap size={16} /></span>
              <span className="perf-label">{t('dashboard.botPerf.responseRate')}</span>
              <span className="perf-val">{fs ? `${responsePct}%` : dash}</span>
            </div>
            <ProgressBar value={fs?.response_rate ?? 0} color={ACCENT.resolution} />
          </div>
        </section>
      </div>

      <section className="panel sessions-section">
        <div className="section-header">
          <h2>{t('dashboard.sessionsOverview')}</h2>
          <span className="section-subtitle">
            {t('dashboard.showingSessions', { shown: sessions.length, total: stats?.total ?? 0 })}
          </span>
        </div>

        <div className="sessions-table">
          <div className="table-header">
            <span>{t('dashboard.columns.sessionId')}</span>
            <span>{t('dashboard.columns.phone')}</span>
            <span>{t('dashboard.columns.status')}</span>
            <span>{t('dashboard.columns.lastActive')}</span>
            <span>{t('dashboard.columns.actions')}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="table-row" style={{ justifyContent: 'center', color: 'var(--text-muted)' }}>
              {t('dashboard.noSessions')}
            </div>
          ) : (
            sessions.map(session => (
              <div key={session.id} className="table-row">
                <div className="session-info-cell">
                  <span className="session-id">{session.id.substring(0, 12)}</span>
                  <span className="session-name" title={session.name}>{session.name}</span>
                </div>
                <span className="phone">{session.phone || '—'}</span>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
                <span className="last-active">{formatLastActive(session.lastActive)}</span>
                <div className="actions">
                  <button className="btn-sm" onClick={() => navigate('/sessions')}>{t('dashboard.view')}</button>
                  {['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) && (
                    <button className="btn-sm danger" onClick={() => handleDisconnect(session.id)}>
                      {t('dashboard.disconnect')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
