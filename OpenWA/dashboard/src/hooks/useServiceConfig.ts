import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LocalizedString,
  type ServiceConfig,
  type ServiceType,
  fillTemplate,
  getServiceConfig,
  localize,
  resolveServiceType,
} from '../config/serviceConfig';

/**
 * Resolves the seller's vertical (`sellers.business_category`) into a live
 * `ServiceConfig` and returns ready-to-render, language-aware label helpers.
 *
 * Why this is NOT folded into `useOrganization`: that hook polls billing
 * every 30 s and is mounted in the top bar. The vertical changes at most
 * a handful of times in a seller's life (only when they edit it in
 * Settings), so we fetch it once and cache it process-wide — no polling,
 * no second 30 s timer per page. Components just call `useServiceConfig()`
 * and get terminology that already matches the seller + the active UI
 * language; a tiny module cache dedupes the underlying request so ten
 * components mounting at once still trigger exactly one fetch.
 *
 * Usage:
 *   const { config, label, fill } = useServiceConfig();
 *   <h1>{label(config.ordersTitle)}</h1>
 *   <span>{fill(config.activity.newOrder, { customer, product })}</span>
 *
 * Callers that already hold the category (e.g. a page that also runs
 * `useOrganization`) can pass it in to skip the fetch entirely:
 *   const sc = useServiceConfig(org.business_category);
 */

// ── Process-wide cache for the seller's business_category ──────────────
// Keyed by seller id so switching accounts in the same tab re-fetches.
let _cache: { sellerId: string; value: string | null } | null = null;
let _inflight: Promise<string | null> | null = null;

function currentSellerId(): string {
  try {
    return sessionStorage.getItem('leadecombot_seller_id') || '';
  } catch {
    return '';
  }
}

async function fetchBusinessCategory(): Promise<string | null> {
  const sellerId = currentSellerId();
  if (!sellerId) return null;
  if (_cache && _cache.sellerId === sellerId) return _cache.value;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await fetch('/funnel/billing/usage', {
        headers: { 'X-Seller-Id': sellerId },
      });
      if (!r.ok) {
        _cache = { sellerId, value: null };
        return null;
      }
      const j = await r.json();
      const value: string | null = j.business_category ?? null;
      _cache = { sellerId, value };
      return value;
    } catch {
      _cache = { sellerId, value: null };
      return null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Drop the cached vertical so the next `useServiceConfig` mount re-fetches.
 * Call this right after the seller saves a new business_category in Settings
 * so the whole dashboard re-skins without a hard page reload.
 */
export function invalidateServiceConfig(): void {
  _cache = null;
  _inflight = null;
}

export interface UseServiceConfig {
  /** Resolved vertical key (e.g. 'clinic'). */
  serviceType: ServiceType;
  /** The full config block for that vertical. */
  config: ServiceConfig;
  /** Raw business_category as stored on the seller (null until loaded). */
  businessCategory: string | null;
  /** false until the one-shot category fetch resolves. */
  ready: boolean;
  /** Pick the active-language string out of a LocalizedString. */
  label: (s: LocalizedString) => string;
  /** Localize + interpolate {placeholders} in one call. */
  fill: (s: LocalizedString, vars: Record<string, string>) => string;
}

export function useServiceConfig(businessCategoryOverride?: string | null): UseServiceConfig {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const hasOverride = businessCategoryOverride !== undefined;

  const [fetched, setFetched] = useState<string | null>(() => _cache?.value ?? null);
  const [ready, setReady] = useState<boolean>(() => hasOverride || _cache !== null);

  useEffect(() => {
    if (hasOverride) {
      setReady(true);
      return;
    }
    let alive = true;
    void fetchBusinessCategory().then((v) => {
      if (!alive) return;
      setFetched(v);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [hasOverride]);

  const businessCategory = hasOverride ? (businessCategoryOverride ?? null) : fetched;
  const serviceType = useMemo(
    () => resolveServiceType(businessCategory),
    [businessCategory],
  );
  const config = useMemo(() => getServiceConfig(serviceType), [serviceType]);

  const label = useCallback((s: LocalizedString) => localize(s, lang), [lang]);
  const fill = useCallback(
    (s: LocalizedString, vars: Record<string, string>) =>
      fillTemplate(localize(s, lang), vars),
    [lang],
  );

  return { serviceType, config, businessCategory, ready, label, fill };
}
