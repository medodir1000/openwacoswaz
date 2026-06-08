// API Service Layer for OpenWA Dashboard
// Centralized API client with TypeScript types

const API_BASE_URL = '/api';

// =============================================================================
// Types
// =============================================================================

export interface Session {
  id: string;
  name: string;
  status: 'created' | 'idle' | 'initializing' | 'connecting' | 'qr_ready' | 'ready' | 'disconnected';
  phone?: string;
  pushName?: string;
  lastActive?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStats {
  total: number;
  active: number;
  ready: number;
  disconnected: number;
  byStatus: Record<string, number>;
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
}

export interface Webhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  role: 'admin' | 'user' | 'readonly';
  allowedIps?: string[];
  allowedSessions?: string[];
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  createdAt: string;
  apiKey?: string; // Only returned on creation
}

export interface AuditLog {
  id: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
  apiKeyId?: string;
  apiKeyName?: string;
  sessionId?: string;
  sessionName?: string;
  ipAddress?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  errorMessage?: string;
  createdAt: string;
}

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

export interface HealthStatus {
  status: 'ok' | 'error';
  timestamp?: string;
  details?: {
    database?: { status: string };
    redis?: { status: string };
    queue?: { status: string };
  };
}

export interface InfraStatus {
  database: { connected: boolean; type: string; host: string };
  redis: { connected: boolean; host: string; port: number };
  queue: {
    enabled: boolean;
    messages: { pending: number; completed: number; failed: number };
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string };
  engine: { type: string; headless: boolean };
}

export interface SaveConfigPayload {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    poolSize?: number;
    sslEnabled?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

export interface Settings {
  general: { apiBaseUrl: string; sessionTimeout: number; autoReconnect: boolean; debugMode: boolean };
  api: { rateLimit: number; rateLimitWindow: number; enableDocs: boolean };
  notifications: { emailEnabled: boolean; notificationEmail: string; webhookAlerts: boolean };
}

// =============================================================================
// API Client
// =============================================================================

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('openwa_api_key');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...options.headers,
  };

  // Guard against a hung/unreachable gateway. Without a timeout, a stalled
  // upstream (e.g. the OpenWA gateway offline on Railway) leaves this await
  // pending forever — which is exactly what strands UI spinners like the
  // "Créer une session" button. Abort after 45s so callers surface a clear
  // error instead of spinning indefinitely. 45s leaves headroom for the one
  // genuinely slow call (POST /sessions/:id/start launches Chromium).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        'The WhatsApp gateway did not respond (timed out). It may be offline — please try again in a moment.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// =============================================================================
// Session API
// =============================================================================

const SESSION_STATUSES: Session['status'][] = [
  'created', 'idle', 'initializing', 'connecting', 'qr_ready', 'ready', 'disconnected',
];

/**
 * Map a brain /funnel/wa-sessions row onto the dashboard's Session shape.
 * The brain returns { id, name, phone, status, lastActive } and may report
 * the persisted "connected" label when the live gateway status is briefly
 * unavailable, so we fold that onto our union and synthesize the timestamp
 * fields the brain doesn't track for a paired number.
 */
function normalizeOwnedSession(s: {
  id: string;
  name?: string;
  phone?: string;
  status?: string;
  lastActive?: string;
}): Session {
  const raw = (s.status || '').toLowerCase();
  const status: Session['status'] =
    raw === 'connected'
      ? 'ready'
      : (SESSION_STATUSES as string[]).includes(raw)
        ? (raw as Session['status'])
        : 'disconnected';
  return {
    id: s.id,
    name: s.name || s.phone || s.id.slice(0, 8),
    status,
    phone: s.phone || undefined,
    lastActive: s.lastActive || undefined,
    createdAt: s.lastActive || '',
    updatedAt: s.lastActive || '',
  };
}

export const sessionApi = {
  list: () => request<Session[]>('/sessions'),
  /**
   * List ONLY the WhatsApp numbers paired by THIS seller, via the brain's
   * tenant-scoped endpoint. The raw gateway /sessions route (list, above)
   * returns EVERY tenant's session because all sellers share one OpenWA
   * gateway + master API key — using it in seller context leaks other
   * sellers' numbers (and stale test sessions) into a fresh account. The
   * brain owns the seller→session mapping (seller_whatsapp_sessions) and
   * filters for us. Admins still use list() for the full fleet view.
   */
  listOwned: async (sellerId: string): Promise<Session[]> => {
    const r = await fetch('/funnel/wa-sessions', { headers: { 'X-Seller-Id': sellerId } });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    const raw: Array<{ id: string; name?: string; phone?: string; status?: string; lastActive?: string }> =
      Array.isArray(j.sessions) ? j.sessions : [];
    return raw.filter(s => s && s.id).map(normalizeOwnedSession);
  },
  /**
   * Claim a freshly-created session for THIS seller via the brain, so it
   * persists in their list after a refresh (the gateway POST /sessions is
   * tenant-blind, so without this the new session has no seller→session row
   * and vanishes on reload). The brain refuses to claim a jid already owned
   * by another tenant, so this can't be used to adopt someone else's number.
   */
  registerOwned: async (sellerId: string, jid: string, phone?: string): Promise<void> => {
    const r = await fetch('/funnel/wa-sessions/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Seller-Id': sellerId },
      body: JSON.stringify({ jid, phone: phone || '' }),
    });
    // 409 = already owned by another tenant: surface nothing, the session
    // still exists on the gateway. Any other failure is worth knowing about.
    if (!r.ok && r.status !== 409) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      // 402 trial_expired carries a friendly `message`; prefer it over the code.
      throw new Error(err.message || err.error || `HTTP ${r.status}`);
    }
  },
  /**
   * Drop the seller→session ownership row in the brain (counterpart to
   * registerOwned). Called on delete so the number doesn't resurrect in the
   * list on reload — and so a stale row (whose gateway session is already
   * gone, i.e. gateway delete 404'd) can still be cleared. Scoped to the
   * caller by the brain; idempotent, so a missing row is not an error.
   */
  unregisterOwned: async (sellerId: string, jid: string): Promise<void> => {
    const r = await fetch(`/funnel/wa-sessions/${encodeURIComponent(jid)}`, {
      method: 'DELETE',
      headers: { 'X-Seller-Id': sellerId },
    });
    if (!r.ok && r.status !== 404) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
  },
  get: (id: string) => request<Session>(`/sessions/${id}`),
  create: (name: string) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  delete: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  start: (id: string) => request<Session>(`/sessions/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: 'POST' }),
  getQR: (id: string) => request<{ qrCode: string; status: string }>(`/sessions/${id}/qr`),
  getStats: () => request<SessionStats>('/sessions/stats/overview'),
  getGroups: (id: string) => request<{ id: string; name: string }[]>(`/sessions/${id}/groups`),
};

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${sessionId}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  get: (sessionId: string, id: string) => request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`),
  create: (sessionId: string, data: { url: string; events: string[] }) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<Webhook>) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(`/sessions/${sessionId}/webhooks/${id}/test`, {
      method: 'POST',
    }),
};

// =============================================================================
// API Key API
// =============================================================================

export const apiKeyApi = {
  list: () => request<ApiKey[]>('/auth/api-keys'),
  get: (id: string) => request<ApiKey>(`/auth/api-keys/${id}`),
  create: (data: {
    name: string;
    role: string;
    allowedIps?: string[];
    allowedSessions?: string[];
    expiresAt?: string;
  }) =>
    request<ApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<ApiKey>) =>
    request<ApiKey>(`/auth/api-keys/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/auth/api-keys/${id}`, { method: 'DELETE' }),
  revoke: (id: string) => request<ApiKey>(`/auth/api-keys/${id}/revoke`, { method: 'POST' }),
};

// =============================================================================
// Audit/Logs API
// =============================================================================

export const auditApi = {
  list: (params?: { action?: string; severity?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.action) query.set('action', params.action);
    if (params?.severity) query.set('severity', params.severity);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const queryStr = query.toString();
    return request<{ data: AuditLog[]; total: number }>(`/audit${queryStr ? `?${queryStr}` : ''}`);
  },
};

// =============================================================================
// Message API
// =============================================================================

export const messageApi = {
  sendText: (sessionId: string, chatId: string, text: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    }),
  sendImage: (sessionId: string, chatId: string, url: string, caption?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-image`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, caption }),
    }),
  sendVideo: (sessionId: string, chatId: string, url: string, caption?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-video`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, caption }),
    }),
  sendAudio: (sessionId: string, chatId: string, url: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-audio`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url }),
    }),
  sendDocument: (sessionId: string, chatId: string, url: string, filename?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-document`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, filename }),
    }),
};

// =============================================================================
// Health & Infrastructure API
// =============================================================================

export const healthApi = {
  check: () => request<HealthStatus>('/health'),
  ready: () => request<HealthStatus>('/health/ready'),
};

export const infraApi = {
  getStatus: () => request<InfraStatus>('/infra/status'),
  updateConfig: (config: Partial<InfraStatus>) =>
    request<InfraStatus>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  saveConfig: (config: SaveConfigPayload) =>
    request<{ message: string; saved: boolean; envPath: string; profiles: string[] }>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restart: (profiles?: string[], profilesToRemove?: string[]) =>
    request<{
      message: string;
      restarting: boolean;
      profiles: string[];
      profilesToRemove: string[];
      estimatedTime: number;
    }>('/infra/restart', {
      method: 'POST',
      body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
    }),
  healthCheck: () => request<{ status: string; timestamp: string }>('/infra/health'),
};

// =============================================================================
// Settings API
// =============================================================================

export const settingsApi = {
  get: () => request<Settings>('/settings'),
  update: (settings: Partial<Settings>) =>
    request<Settings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
};

// =============================================================================
// Plugin Types
// =============================================================================

export interface Plugin {
  id: string;
  name: string;
  version: string;
  type: 'engine' | 'storage' | 'queue' | 'auth' | 'extension';
  description?: string;
  author?: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  config: Record<string, unknown>;
  builtIn: boolean;
  provides: string[];
  loadedAt?: string;
  enabledAt?: string;
  error?: string;
}

export interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  features: string[];
}

// =============================================================================
// Plugins API
// =============================================================================

export const pluginsApi = {
  list: () => request<Plugin[]>('/plugins'),
  get: (id: string) => request<Plugin>(`/plugins/${id}`),
  enable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/enable`, {
      method: 'POST',
    }),
  disable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/disable`, {
      method: 'POST',
    }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  healthCheck: (id: string) => request<{ healthy: boolean; message?: string }>(`/plugins/${id}/health`),
  getEngines: () => request<Engine[]>('/infra/engines'),
  getCurrentEngine: () => request<{ engineType: string }>('/infra/engines/current'),
};

// =============================================================================
// Funnel (brain) client — tenant-scoped
// =============================================================================
//
// The brain (Flask, proxied at /funnel) is the multi-tenant boundary: every
// request must carry the current seller's id so the brain scopes reads/writes
// to that tenant. We mirror the X-Seller-Id pattern used by sessionApi.listOwned
// and BotFunnel's ffetch. Unlike the gateway client, the brain reports failures
// as { error: "..." }, so we surface that field.

/** The seller id stamped at login; empty in admin context. */
function funnelSellerId(): string {
  return sessionStorage.getItem('leadecombot_seller_id') || '';
}

async function funnelRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const sellerId = funnelSellerId();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(sellerId ? { 'X-Seller-Id': sellerId } : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || err.message || `HTTP ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

// =============================================================================
// Shopify Integration API
// =============================================================================

/** Dashboard-safe projection of a seller's connected Shopify store. Secrets
 *  are masked to their last 4 chars by the brain (access_token_hint, etc.). */
export interface ShopifyIntegration {
  connected: boolean;
  status?: 'connected' | 'error' | 'disconnected';
  shop_domain?: string;
  access_token_hint?: string;
  api_secret_hint?: string;
  webhook_registered?: boolean;
  webhook_api_version?: string | null;
  last_order_at?: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ShopifyStatusResponse {
  integration: ShopifyIntegration;
  /** True when PUBLIC_BASE_URL is a public https URL so webhooks auto-register. */
  public_url_configured: boolean;
  /** The orders/create endpoint Shopify should call. */
  webhook_url: string;
  api_version: string;
}

export interface ShopifyConnectResponse {
  ok: boolean;
  shop_name: string;
  integration: ShopifyIntegration;
  webhook_registered: boolean;
  webhook_url: string;
  /** Non-null when credentials saved but the webhook couldn't auto-register. */
  webhook_warning: string | null;
}

export interface ShopifyDisconnectResponse {
  ok: boolean;
  deleted?: boolean;
  already_disconnected?: boolean;
}

export const shopifyApi = {
  /** Masked connection status + webhook config for the Integrations page. */
  getStatus: () => funnelRequest<ShopifyStatusResponse>('/funnel/integrations/shopify'),
  /** Verify Custom App credentials, auto-register the orders/create webhook,
   *  and persist the integration. */
  connect: (data: { shop_domain: string; access_token: string; api_secret: string }) =>
    funnelRequest<ShopifyConnectResponse>('/funnel/integrations/shopify/connect', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Remove the webhook from Shopify and delete stored credentials. Idempotent. */
  disconnect: () =>
    funnelRequest<ShopifyDisconnectResponse>('/funnel/integrations/shopify/disconnect', {
      method: 'POST',
    }),
};
