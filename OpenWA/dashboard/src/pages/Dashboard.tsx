import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare, Target, ShoppingBag, Send, Inbox, Zap,
  ArrowUpRight, ArrowDownRight, Loader2, Sparkles,
  Plus, Smartphone, MessagesSquare,
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
// optional so an older brain degrades gracefully (cards fall back to 0/em-dash).
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

// Teal-led KPI accents (design-system: no purple). One hue per card.
const ACCENT = {
  conversations: '#0F766E', // brand-600
  contacts: '#13A08A',      // brand-500
  resolution: '#0E7490',    // info
  conversions: '#B54708',   // warning
};
// Brand-true channel colours; unknown order sources fall back to grey.
const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: '#25D366',
  shopify: '#95BF47',
};
const CHANNEL_FALLBACK = '#9CA3AF';

// % change of `curr` vs `prev`. up=null means "no movement / no baseline".
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

// ── KPI tile — Soft UI (bento) ──────────────────────────────────────────
function KpiCard({ label, value, icon: Icon, accent, trendInfo, spark, progress, sub }: KpiCardProps) {
  return (
    <div className="group h-full rounded-card border border-ink-200 bg-surface p-5 shadow-soft transition duration-200 hover:-translate-y-px hover:shadow-soft-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">{label}</span>
          <span className="font-display text-2xl font-bold text-ink-900">{value}</span>
        </div>
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: `${accent}1a`, color: accent }}
        >
          <Icon size={20} />
        </span>
      </div>

      {trendInfo && trendInfo.up !== null && (
        <div className={`mt-2 flex items-center gap-1 text-xs font-medium ${trendInfo.up ? 'text-success' : 'text-danger'}`}>
          {trendInfo.up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          <span>{trendInfo.pct}%</span>
          <span className="text-ink-500">{trendInfo.caption}</span>
        </div>
      )}
      {sub && <div className="mt-2 text-xs text-ink-500">{sub}</div>}

      <div className="mt-3 h-[30px]">
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

// ── Quick action button (Soft UI) ───────────────────────────────────────
function QuickAction({ icon: Icon, label, onClick, primary }: {
  icon: LucideIcon; label: string; onClick: () => void; primary?: boolean;
}) {
  const base =
    'inline-flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-sm font-semibold transition duration-200 hover:-translate-y-px cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40';
  const skin = primary
    ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-700'
    : 'border border-ink-200 bg-surface text-ink-700 hover:bg-ink-100';
  return (
    <button type="button" onClick={onClick} className={`${base} ${skin}`}>
      <Icon size={16} /> {label}
    </button>
  );
}

export function Dashboard() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const { data: stats } = useSessionStatsQuery();
  const stopMutation = useStopSessionMutation();

  // Vertical-aware vocabulary for the trends + live-activity feed.
  const { config, label, fill } = useServiceConfig();

  // Billing/trial snapshot (polls /funnel/billing/usage every 30s).
  const org = useOrganization();

  // Brain-side analytics. Polled every 30s, scoped by X-Seller-Id.
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

  // Recent activity — last handful of orders, relabeled for the seller's vertical.
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
      <div className="dashboard tw grid min-h-[400px] place-items-center">
        <Loader2 className="animate-spin text-brand-600" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard tw p-8">
        <div className="rounded-card border border-danger/30 bg-danger-tint p-4 text-danger">
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
  const convoCumulative = convoSeries.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] ?? 0) + v);
    return acc;
  }, []);

  const conversionsTrend = trend(fs?.conversions_7d ?? 0, fs?.conversions_prev_7d ?? 0);
  const resolutionPct = Math.round((fs?.resolution_rate ?? 0) * 100);
  const responsePct = Math.round((fs?.response_rate ?? 0) * 100);
  const vsCaption = t('dashboard.kpi.vsPrevWeek');
  const totalMessages = fs ? (fs.messages_sent ?? 0) + (fs.messages_received ?? 0) : undefined;

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

  // ── Plan / trial status ───────────────────────────────────────────────
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

  const connected = !!(stats && stats.ready > 0);

  return (
    <div className="dashboard tw font-sans text-ink-700">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        badge={
          <span className={`status-badge ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? t('common.connected') : t('common.disconnected')}
          </span>
        }
      />

      {/* Quick actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <QuickAction icon={Plus} label={t('dashboard.quick.createBot', 'Create bot')} onClick={() => navigate('/funnel')} primary />
        <QuickAction icon={MessagesSquare} label={t('dashboard.quick.analytics', 'Conversations')} onClick={() => navigate('/conversations')} />
        <QuickAction icon={Smartphone} label={t('dashboard.quick.connect', 'Connect number')} onClick={() => navigate('/sessions')} />
      </div>

      {/* Plan / trial tile */}
      <section
        className={`mb-4 rounded-card border bg-surface p-5 shadow-soft ${
          planTrialEnded ? 'border-danger/40' : planTrialWarn ? 'border-warning/40' : 'border-ink-200'
        }`}
      >
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">
            {org.is_trial ? <Sparkles size={20} /> : <Zap size={20} />}
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">{t('dashboard.plan.eyebrow', 'Your plan')}</span>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-bold text-ink-900">{planName}</span>
              {org.is_trial && (
                <span className="rounded-pill bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-800">
                  {planTrialEnded ? t('dashboard.plan.trialEnded', 'Trial ended') : t('dashboard.plan.trialTag', 'Trial')}
                </span>
              )}
            </div>
            <span className="text-sm text-ink-500">
              {org.is_trial
                ? t('dashboard.plan.trialSub', 'Full bot · 1 WhatsApp session, no feature locks')
                : planIsPaid
                  ? t('dashboard.plan.paidSub', '{{count}} WhatsApp sessions included', { count: org.sessions_included })
                  : t('dashboard.plan.freeSub', '1 WhatsApp session · upgrade to lift the limits')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="text-center">
              <div className="font-display text-xl font-bold text-ink-900">
                {org.is_trial ? Math.max(0, org.trial_days_left) : planIsPaid ? Math.max(0, org.days_to_renewal) : '∞'}
              </div>
              <div className="text-[11px] text-ink-500">
                {org.is_trial ? t('dashboard.plan.daysLeft', 'days left') : planIsPaid ? t('dashboard.plan.untilRenewal', 'days until renewal') : t('dashboard.plan.noExpiry', 'no time limit')}
              </div>
            </div>
            <div className="text-center">
              <div className="font-display text-xl font-bold text-ink-900">
                {org.is_trial ? `${planTrialUsed}/${planTrialCap}` : planConversations.toLocaleString()}
              </div>
              <div className="text-[11px] text-ink-500">
                {org.is_trial ? t('dashboard.plan.conversationsUsed', 'conversations used') : t('dashboard.plan.conversationsHandled', 'conversations handled')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('/billing')}
              className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition duration-200 hover:bg-brand-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
            >
              {org.is_trial ? t('dashboard.plan.ctaTrial', 'Choose a plan') : planIsPaid ? t('dashboard.plan.ctaPaid', 'Manage plan') : t('dashboard.plan.ctaFree', 'Upgrade')}
              <ArrowUpRight size={15} />
            </button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-ink-100">
            <div className="h-full rounded-pill bg-brand-500 transition-[width] duration-300" style={{ width: `${planBarPct}%` }} />
          </div>
          <span className="shrink-0 text-xs text-ink-500">
            {org.is_trial
              ? t('dashboard.plan.trialBar', '{{used}} of {{cap}} free conversations', { used: planTrialUsed, cap: planTrialCap })
              : t('dashboard.plan.fairUseBar', '{{pct}}% of monthly fair-use', { pct: planBarPct })}
          </span>
        </div>
      </section>

      {/* Bento grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* Stats overview */}
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <KpiCard
            label={t('dashboard.kpi.messages', 'Total messages')}
            value={num(totalMessages)}
            icon={MessageSquare}
            accent={ACCENT.conversations}
            spark={hasSeries ? { data: convoCumulative, gradId: 'sp-conv' } : null}
          />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
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
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <KpiCard
            label={t('dashboard.kpi.activeBots', 'Active bots')}
            value={stats ? String(stats.ready) : dash}
            icon={Zap}
            accent={ACCENT.contacts}
            sub={stats ? t('dashboard.kpi.activeBotsSub', '{{total}} total sessions', { total: stats.total }) : null}
          />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <KpiCard
            label={t('dashboard.kpi.conversions')}
            value={num(fs?.conversions_total)}
            icon={ShoppingBag}
            accent={ACCENT.conversions}
            trendInfo={{ ...conversionsTrend, caption: vsCaption }}
            spark={hasSeries ? { data: orderSeries, gradId: 'sp-conversions' } : null}
          />
        </div>

        {/* Conversations chart */}
        <section className="col-span-12 rounded-card border border-ink-200 bg-surface p-5 shadow-soft xl:col-span-8">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-ink-900">{t('dashboard.charts.conversationsTitle')}</h2>
              <span className="text-sm text-ink-500">{t('dashboard.charts.conversationsSub')}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-ink-500">
              <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: ACCENT.conversations }} />{t('dashboard.charts.legendConversations')}</span>
              <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: ACCENT.conversions }} />{orderLegendLabel}</span>
            </div>
          </div>
          {hasSeries ? (
            <AreaChart series={series} convoColor={ACCENT.conversations} orderColor={ACCENT.conversions} fmtTick={fmtTick} />
          ) : (
            <div className="grid h-[220px] place-items-center text-sm text-ink-400">{t('dashboard.charts.noData')}</div>
          )}
        </section>

        {/* Channels donut */}
        <section className="col-span-12 rounded-card border border-ink-200 bg-surface p-5 shadow-soft xl:col-span-4">
          <div className="mb-3">
            <h2 className="font-display text-base font-semibold text-ink-900">{t('dashboard.charts.channelsTitle')}</h2>
            <span className="text-sm text-ink-500">{t('dashboard.charts.channelsSub')}</span>
          </div>
          {channelTotal > 0 ? (
            <Donut segments={channelSegments} total={channelTotal} centerLabel={orderLegendLabel} />
          ) : (
            <div className="grid h-[200px] place-items-center text-sm text-ink-400">{t('dashboard.charts.noData')}</div>
          )}
        </section>

        {/* Recent WhatsApp chats */}
        <section className="col-span-12 rounded-card border border-ink-200 bg-surface p-5 shadow-soft xl:col-span-8">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600"><MessagesSquare size={16} /></span>
            <div>
              <h2 className="font-display text-base font-semibold text-ink-900">{t('dashboard.recentActivity')}</h2>
              <span className="text-sm text-ink-500">{t('dashboard.recentActivitySubtitle')}</span>
            </div>
          </div>
          {recentOrders.length === 0 ? (
            <div className="grid h-24 place-items-center text-sm text-ink-400">{t('dashboard.noActivity')}</div>
          ) : (
            <ul className="flex flex-col">
              {recentOrders.map(o => (
                <li key={o.id} className="flex items-center gap-3 border-b border-ink-100 py-2.5 last:border-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600"><MessageSquare size={15} /></span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{activityLine(o)}</span>
                  <span className={`status-pill ${o.status}`}>{orderStatusLabel(o.status)}</span>
                  <span className="shrink-0 text-xs text-ink-400">{formatLastActive(o.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Bot performance */}
        <section className="col-span-12 rounded-card border border-ink-200 bg-surface p-5 shadow-soft xl:col-span-4">
          <div className="mb-3">
            <h2 className="font-display text-base font-semibold text-ink-900">{t('dashboard.botPerf.title')}</h2>
            <span className="text-sm text-ink-500">{t('dashboard.botPerf.window')}</span>
          </div>
          <div className="flex items-center gap-3 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px]" style={{ background: `${ACCENT.conversations}1a`, color: ACCENT.conversations }}><Send size={16} /></span>
            <span className="flex-1 text-sm text-ink-600">{t('dashboard.botPerf.messagesSent')}</span>
            <span className="font-mono text-sm font-medium text-ink-900">{num(fs?.messages_sent)}</span>
          </div>
          <div className="flex items-center gap-3 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px]" style={{ background: `${ACCENT.contacts}1a`, color: ACCENT.contacts }}><Inbox size={16} /></span>
            <span className="flex-1 text-sm text-ink-600">{t('dashboard.botPerf.messagesReceived')}</span>
            <span className="font-mono text-sm font-medium text-ink-900">{num(fs?.messages_received)}</span>
          </div>
          <div className="mt-2 border-t border-ink-100 pt-3">
            <div className="mb-1.5 flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px]" style={{ background: `${ACCENT.resolution}1a`, color: ACCENT.resolution }}><Zap size={16} /></span>
              <span className="flex-1 text-sm text-ink-600">{t('dashboard.botPerf.responseRate')}</span>
              <span className="font-mono text-sm font-medium text-ink-900">{fs ? `${responsePct}%` : dash}</span>
            </div>
            <ProgressBar value={fs?.response_rate ?? 0} color={ACCENT.resolution} />
          </div>
        </section>

        {/* Sessions table */}
        <section className="col-span-12 rounded-card border border-ink-200 bg-surface p-5 shadow-soft">
          <div className="mb-3">
            <h2 className="font-display text-base font-semibold text-ink-900">{t('dashboard.sessionsOverview')}</h2>
            <span className="text-sm text-ink-500">
              {t('dashboard.showingSessions', { shown: sessions.length, total: stats?.total ?? 0 })}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-500">
                  <th className="py-2 pr-3 font-semibold">{t('dashboard.columns.sessionId')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('dashboard.columns.phone')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('dashboard.columns.status')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('dashboard.columns.lastActive')}</th>
                  <th className="py-2 text-right font-semibold">{t('dashboard.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr><td colSpan={5} className="py-6 text-center text-ink-400">{t('dashboard.noSessions')}</td></tr>
                ) : (
                  sessions.map(session => (
                    <tr key={session.id} className="border-b border-ink-100 transition-colors duration-150 last:border-0 hover:bg-brand-50">
                      <td className="py-2.5 pr-3">
                        <div className="flex flex-col">
                          <span className="font-mono text-xs text-ink-500">{session.id.substring(0, 12)}</span>
                          <span className="text-ink-800" title={session.name}>{session.name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-ink-700">{session.phone || '—'}</td>
                      <td className="py-2.5 pr-3"><span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span></td>
                      <td className="py-2.5 pr-3 text-ink-500">{formatLastActive(session.lastActive)}</td>
                      <td className="py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => navigate('/sessions')} className="rounded-md border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 transition duration-150 hover:bg-ink-100 cursor-pointer">{t('dashboard.view')}</button>
                          {['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) && (
                            <button onClick={() => handleDisconnect(session.id)} className="rounded-md border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger transition duration-150 hover:bg-danger-tint cursor-pointer">{t('dashboard.disconnect')}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
