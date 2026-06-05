import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionApi,
  webhookApi,
  apiKeyApi,
  auditApi,
  infraApi,
  pluginsApi,
  type Webhook,
  type Session,
  type SessionStats,
} from '../services/api';

/** Is the dashboard currently in a single-seller (tenant) context? */
function currentSellerId(): string {
  return sessionStorage.getItem('leadecombot_seller_id') || '';
}

/**
 * Only a real admin may read the gateway's GLOBAL session fleet. A seller
 * session that somehow has no seller id (e.g. a login payload that dropped
 * seller_id) must NEVER fall through to the global list — that would leak
 * every other tenant's WhatsApp numbers into the account. We gate the
 * fallback on the explicit admin role, not merely "seller id is empty".
 */
function isAdminContext(): boolean {
  return sessionStorage.getItem('codhelix_role') === 'admin';
}

/**
 * Derive session counters from a tenant-scoped session list, so a seller's
 * Dashboard never reflects the gateway's GLOBAL fleet (which spans every
 * tenant + stale test sessions). Mirrors the shape the gateway's
 * /sessions/stats/overview returns; memoryUsage is gateway-process-level and
 * irrelevant per-tenant, so it reports zeros.
 */
function deriveSessionStats(sessions: Session[]): SessionStats {
  const byStatus: Record<string, number> = {};
  for (const s of sessions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  const active = sessions.filter(s =>
    ['ready', 'connecting', 'initializing', 'qr_ready'].includes(s.status),
  ).length;
  return {
    total: sessions.length,
    active,
    ready: byStatus['ready'] || 0,
    disconnected: byStatus['disconnected'] || 0,
    byStatus,
    memoryUsage: { heapUsed: 0, heapTotal: 0, rss: 0 },
  };
}

// ── Query Keys ────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  sessionStats: ['sessions', 'stats'] as const,
  sessionGroups: (sessionId: string) => ['sessions', sessionId, 'groups'] as const,
  webhooks: ['webhooks'] as const,
  apiKeys: ['apiKeys'] as const,
  logs: (params: { severity?: string; page: number; limit: number }) =>
    ['logs', params] as const,
  infraStatus: ['infra', 'status'] as const,
  plugins: ['plugins'] as const,
  engines: ['engines'] as const,
  currentEngine: ['engines', 'current'] as const,
};

// ── Session Queries ───────────────────────────────────────────────────

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    // Seller → only their own paired numbers (brain, tenant-scoped). Admin →
    // the raw gateway list (full fleet). The gateway endpoint has no per-seller
    // filter, so a seller must never read it directly — a seller-role session
    // missing its id shows NOTHING rather than leaking the global fleet.
    queryFn: () => {
      const sellerId = currentSellerId();
      if (sellerId) return sessionApi.listOwned(sellerId);
      return isAdminContext() ? sessionApi.list() : Promise.resolve<Session[]>([]);
    },
    staleTime: 30_000,
  });
}

export function useSessionStatsQuery() {
  return useQuery({
    queryKey: queryKeys.sessionStats,
    queryFn: async (): Promise<SessionStats> => {
      const sellerId = currentSellerId();
      // Seller → derive counters from their own sessions so the "active
      // sessions" card never counts another tenant. Admin → gateway fleet
      // stats. A seller-role session missing its id derives from an empty
      // list (zeros), never the global fleet.
      if (sellerId) {
        const owned = await sessionApi.listOwned(sellerId);
        return deriveSessionStats(owned);
      }
      return isAdminContext() ? sessionApi.getStats() : deriveSessionStats([]);
    },
    staleTime: 30_000,
  });
}

export function useSessionGroupsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionGroups(sessionId),
    queryFn: () => sessionApi.getGroups(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    // Create on the (tenant-blind) gateway, then — for a seller — claim the
    // new session so it persists in their list after a refresh and inbound
    // routes to them. Claim failures are non-fatal: the session still exists
    // on the gateway and can be attributed on first inbound message.
    mutationFn: async (name: string) => {
      const session = await sessionApi.create(name);
      const sellerId = currentSellerId();
      if (sellerId && session?.id) {
        try {
          await sessionApi.registerOwned(sellerId, session.id);
        } catch {
          /* non-fatal — don't block the create UX */
        }
      }
      return session;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessionStats });
    },
  });
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessionStats });
    },
  });
}

export function useStartSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.start(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.stop(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ── Webhook Queries ───────────────────────────────────────────────────

export function useWebhooksQuery() {
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: webhookApi.listAll,
    staleTime: 30_000,
  });
}

export function useCreateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; url: string; events: string[] }) =>
      webhookApi.create(params.sessionId, { url: params.url, events: params.events }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useUpdateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<Webhook> }) =>
      webhookApi.update(params.sessionId, params.id, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useDeleteWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) =>
      webhookApi.delete(params.sessionId, params.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

// ── API Key Queries ───────────────────────────────────────────────────

export function useApiKeysQuery() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: apiKeyApi.list,
    staleTime: 30_000,
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; role: string; allowedIps?: string[]; allowedSessions?: string[]; expiresAt?: string }) =>
      apiKeyApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useDeleteApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ── Logs Queries ──────────────────────────────────────────────────────

export function useLogsQuery(params: { severity?: string; page: number; limit: number }) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: () =>
      auditApi.list({
        severity: params.severity,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
      }),
    staleTime: 15_000,
  });
}

// ── Infrastructure Queries ────────────────────────────────────────────

export function useInfraStatusQuery() {
  return useQuery({
    queryKey: queryKeys.infraStatus,
    queryFn: infraApi.getStatus,
    staleTime: 30_000,
  });
}

// ── Plugin Queries ────────────────────────────────────────────────────

export function usePluginsQuery() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
}

export function useEnginesQuery() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: pluginsApi.getEngines,
    staleTime: 60_000,
  });
}

export function useCurrentEngineQuery() {
  return useQuery({
    queryKey: queryKeys.currentEngine,
    queryFn: pluginsApi.getCurrentEngine,
    staleTime: 60_000,
  });
}
