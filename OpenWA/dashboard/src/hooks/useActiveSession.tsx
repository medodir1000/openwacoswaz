import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';

/**
 * Global "which WhatsApp number am I looking at?" state.
 *
 * A seller on a paid tier connects several WhatsApp numbers (= sessions:
 * Starter 2, Pro 5, Business 15). Every domain surface — products,
 * services, orders, conversations — is scoped to ONE number at a time so
 * the seller manages each line of business in isolation, plus an
 * "All sessions" view that shows everything.
 *
 * The scoping axis is the SAME one the seller already configures per
 * product: `products.whatsapp_session_ids` (migration 0006). Orders inherit
 * their product's number assignment; conversations inherit the number of
 * the product the bot detected. So no schema change is needed — the brain
 * just surfaces the session ids on each row and we filter here, instantly,
 * with no refetch when the seller switches.
 *
 * Mirrors useOrganization's "thin fetch hook" approach (plain fetch, not
 * TanStack Query) because the switcher lives in Layout.tsx, OUTSIDE the
 * QueryClientProvider auth boundary.
 */
export type WaSession = {
  id: string;       // OpenWA session UUID — the value stored on products
  name: string;     // friendly label ("bot1", "bot12") when OpenWA knows it
  phone: string;    // "212633753099"
  status: string;   // "ready" / "disconnected" / ...
};

interface SessionContextValue {
  sessions: WaSession[];
  /** null = "All sessions" (no filter). */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  /** The resolved WaSession for activeSessionId, or null when "All". */
  activeSession: WaSession | null;
  loading: boolean;
  refresh: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

const STORAGE_KEY = 'codhelix_active_session';
const POLL_MS = 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<WaSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSessionId, setActiveIdState] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY) || null;
  });

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const load = useCallback(async () => {
    const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
    if (!sellerId) {
      // Admin context (no tenant) — nothing to switch between.
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch('/funnel/wa-sessions', {
        headers: { 'X-Seller-Id': sellerId },
      });
      if (!r.ok) { setLoading(false); return; }
      const j = await r.json();
      const list: WaSession[] = Array.isArray(j.sessions) ? j.sessions : [];
      setSessions(list);
      // Drop a stale selection if that number was removed/re-paired under a
      // new UUID — otherwise the seller would be stuck viewing an empty set.
      setActiveIdState((cur) => (cur && !list.some((s) => s.id === cur) ? null : cur));
    } catch {
      /* keep last-known sessions; the switcher stays usable offline */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Keep localStorage and state in sync if the stored id was cleared above.
  useEffect(() => {
    if (activeSessionId) localStorage.setItem(STORAGE_KEY, activeSessionId);
    else localStorage.removeItem(STORAGE_KEY);
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const value: SessionContextValue = {
    sessions,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    loading,
    refresh: load,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useActiveSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (ctx === undefined) {
    // Be forgiving: a page rendered outside the provider (shouldn't happen
    // in practice) degrades to the "All sessions" view instead of crashing.
    return {
      sessions: [],
      activeSessionId: null,
      setActiveSessionId: () => {},
      activeSession: null,
      loading: false,
      refresh: () => {},
    };
  }
  return ctx;
}

/**
 * Does a row belong to the currently-selected WhatsApp number?
 *
 * @param jids            the row's session ids (product.whatsapp_session_ids,
 *                        or the conversation's resolved session_jids).
 * @param activeSessionId the selected number, or null for "All sessions".
 * @param emptyIsAll      how to treat a row with NO session ids:
 *                          • true  (products/orders) — an unpinned product is
 *                            reachable on every number, so it shows under each.
 *                          • false (conversations) — a chat with no detected
 *                            product can't be attributed to a number, so it
 *                            only shows under "All sessions".
 */
export function matchesSession(
  jids: string[] | null | undefined,
  activeSessionId: string | null,
  emptyIsAll = true,
): boolean {
  if (!activeSessionId) return true;          // "All sessions" → no filter
  const ids = jids || [];
  if (ids.length === 0) return emptyIsAll;
  return ids.includes(activeSessionId);
}
