import { useEffect, useState, useCallback } from 'react';

/**
 * Live snapshot of the seller's organization + billing state.
 *
 * Polls `GET /funnel/billing/usage` every 30 seconds so the top-bar
 * "Tokens IA" counter and "Plan" badge stay fresh without a hard
 * refresh. When migration 0009 hasn't been applied yet, the brain
 * returns `migration_applied: false` and we degrade gracefully — the
 * top bar still renders, just with a 0 balance + "Free" plan.
 *
 * Why a thin custom hook instead of TanStack Query: this needs to be
 * accessible from Layout.tsx which sits OUTSIDE the QueryClientProvider
 * (auth boundary). Plain fetch + setInterval is enough.
 */
export type Tier = 'free' | 'starter' | 'pro' | 'business' | 'enterprise';

/** Account access gate (brain `_seller_access_state`). allowed=false once the
 *  free trial has ended with no active paid plan — the seller can't connect a
 *  WhatsApp number or add a product/service until an admin activates a plan. */
export interface AccessState {
  allowed: boolean;
  reason: string;          // ok | trial_active | trial_expired | paid_active | not_trial
  is_trial: boolean;
  trial_days_left: number;
  plan: string | null;     // active paid tier, when any
  pending: boolean;        // a subscription request awaits admin activation
}

export interface OrganizationState {
  organization_id: string | null;
  organization_name: string | null;
  plan: 'free' | 'starter' | 'pro' | 'business';
  tier: Tier;
  preferred_currency: string;
  country_code: string | null;
  /** Seller's vertical (migration 0009). Drives the dynamic multi-service
   *  UI via `useServiceConfig`. null = never set → treated as e-commerce. */
  business_category: string | null;
  // Internal counters — exposed to the dashboard but NOT marketed to
  // sellers. UI surfaces `fair_use_percent` instead so the "unlimited"
  // promise feels true while we cap heavy users behind the scenes.
  ai_tokens_balance: number;
  monthly_token_grant: number;
  fair_use_percent: number;
  sessions_included: number;
  period_starts_at: string | null;
  period_ends_at: string | null;
  days_to_renewal: number;
  // Free-trial snapshot for self-serve signups (brain TRIAL_DAYS /
  // TRIAL_CONVERSATIONS_CAP). is_trial is false for paid sellers and
  // legacy accounts, so the trial UI never shows for them. Drives the
  // Billing trial card + the top-bar countdown pill.
  is_trial: boolean;
  trial_ends_at: string | null;
  trial_days_left: number;
  trial_conversations_used: number;
  trial_conversations_cap: number;
  usage_7d: Array<{ day: string; total_tokens: number }>;
  migration_applied: boolean;
  access: AccessState;
  loading: boolean;
  error: string | null;
}

const POLL_MS = 30_000;

const INITIAL: OrganizationState = {
  organization_id: null,
  organization_name: null,
  plan: 'free',
  tier: 'free',
  preferred_currency: 'USD',
  country_code: null,
  business_category: null,
  ai_tokens_balance: 0,
  monthly_token_grant: 50_000,
  fair_use_percent: 0,
  sessions_included: 1,
  period_starts_at: null,
  period_ends_at: null,
  days_to_renewal: 0,
  is_trial: false,
  trial_ends_at: null,
  trial_days_left: 0,
  trial_conversations_used: 0,
  trial_conversations_cap: 30,
  usage_7d: [],
  migration_applied: false,
  access: { allowed: true, reason: 'ok', is_trial: false, trial_days_left: 0, plan: null, pending: false },
  loading: true,
  error: null,
};

export function useOrganization(): OrganizationState & { refresh: () => void } {
  const [state, setState] = useState<OrganizationState>(INITIAL);

  const load = useCallback(async () => {
    const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
    if (!sellerId) {
      // Admin context (no seller). Skip the fetch but unblock the UI.
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    try {
      const r = await fetch('/funnel/billing/usage', {
        headers: { 'X-Seller-Id': sellerId },
      });
      if (!r.ok) {
        setState((s) => ({ ...s, loading: false, error: `HTTP ${r.status}` }));
        return;
      }
      const j = await r.json();
      setState({
        organization_id:    j.organization_id ?? null,
        organization_name:  j.organization_name ?? null,
        plan:               j.plan ?? 'free',
        tier:               (j.tier ?? j.plan ?? 'free') as Tier,
        preferred_currency: j.preferred_currency ?? 'USD',
        country_code:       j.country_code ?? null,
        business_category:  j.business_category ?? null,
        ai_tokens_balance:  Number(j.ai_tokens_balance ?? 0),
        monthly_token_grant: Number(j.monthly_token_grant ?? 50_000),
        fair_use_percent:   Number(j.fair_use_percent ?? 0),
        sessions_included:  Number(j.sessions_included ?? 1),
        period_starts_at:   j.period_starts_at ?? null,
        period_ends_at:     j.period_ends_at ?? null,
        days_to_renewal:    Number(j.days_to_renewal ?? 0),
        is_trial:           Boolean(j.is_trial),
        trial_ends_at:      j.trial_ends_at ?? null,
        trial_days_left:    Number(j.trial_days_left ?? 0),
        trial_conversations_used: Number(j.trial_conversations_used ?? 0),
        trial_conversations_cap:  Number(j.trial_conversations_cap ?? 30),
        usage_7d:           Array.isArray(j.usage_7d) ? j.usage_7d : [],
        migration_applied:  Boolean(j.migration_applied),
        access: {
          allowed:         j.access?.allowed !== false,   // default allow if absent
          reason:          String(j.access?.reason ?? 'ok'),
          is_trial:        Boolean(j.access?.is_trial),
          trial_days_left: Number(j.access?.trial_days_left ?? 0),
          plan:            j.access?.plan ?? null,
          pending:         Boolean(j.access?.pending),
        },
        loading:            false,
        error:              null,
      });
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        error: (e as Error).message || 'fetch failed',
      }));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  return { ...state, refresh: load };
}

/**
 * Format an AI-tokens count for the top-bar pill.
 *   247         → "247"
 *   12_345      → "12.3k"
 *   1_500_000   → "1.5M"
 *   12_000_000  → "12M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

/** Plan badge labels — keep in sync with i18n keys when those land.
 *  v2 pricing uses "Pack 1" / "Pack 2" naming for paid tiers (per the
 *  user spec) so the customer never sees ambiguous "Starter" framing. */
export const PLAN_LABELS: Record<OrganizationState['plan'], string> = {
  free:     'Free',
  starter:  'Pack 1',
  pro:      'Pack 2',
  business: 'Pack 3',     // not currently sold, kept for future expansion
};

/**
 * Format a money amount in MINOR units (e.g. 17000 MAD centimes →
 * "170 MAD"; 15000000 GNF → "150 000 GNF"; 1700 USD cents → "$17.00").
 * The brain's /funnel/billing/plans returns amount_minor + currency.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'XAF', 'GNF']);

export function formatMoney(amountMinor: number, currency: string): string {
  const cur = (currency || 'USD').toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);
  const major = isZeroDecimal ? amountMinor : amountMinor / 100;
  // For zero-decimal currencies, group thousands with non-breaking
  // space (French convention) — easier on African readers.
  if (isZeroDecimal) {
    return `${major.toLocaleString('fr-FR').replace(/,/g, ' ')} ${cur}`;
  }
  // 2-decimal display for USD/MAD/EGP.
  // fr-FR already gives the French convention (space thousands, comma
  // decimal). The old .replace(/,/g,NBSP) ATE the decimal -> "170 00".
  // Use it directly; whole amounts drop the ",00" -> "170 MAD".
  const hasCents = Math.round(major * 100) % 100 !== 0;
  const formatted = major.toLocaleString('fr-FR', {
    minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2,
  });
  // Show the currency symbol for USD, otherwise the ISO code.
  if (cur === 'USD') return `$${major.toFixed(2)}`;
  return `${formatted} ${cur}`;
}
