import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  X,
  Trash2,
  RefreshCw,
  Link2,
  Link2Off,
  ChevronDown,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { shopifyApi, type ShopifyStatusResponse } from '../services/api';
import './Integrations.css';

/** Official Shopify bag mark (green bag + white "S"), used to identify the
 *  integration partner on the connect card. */
function ShopifyLogo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 448 460"
      role="img"
      aria-label="Shopify"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#95BF47"
        d="M388.32,104.1a4.66,4.66,0,0,0-4.4-4c-2,0-37.23-2.71-37.23-2.71s-24.7-24.51-27.46-27.265c-2.75-2.75-8.13-1.94-10.22-1.32-.31.1-5.48,1.7-14,4.36-8.34-24-23-46.05-48.85-46.05-.71,0-1.45.03-2.19.07C236.66,8.42,228.13,4,220.76,4c-56.5,0-83.49,70.65-91.96,106.56-21.95,6.8-37.55,11.64-39.55,12.27-12.25,3.84-12.64,4.23-14.24,15.78C73.79,147.36,41.58,396.59,41.58,396.59L292.81,443.7l136.13-29.42S388.7,106.06,388.32,104.1ZM263.79,73.13c-6.71,2.08-14.35,4.44-22.62,7,0-1.59.01-3.16.01-4.86,0-14.83-2.06-26.78-5.36-36.26C249,40.74,258.83,55.62,263.79,73.13Zm-44.27-29.9c3.69,9.25,6.09,22.53,6.09,40.46,0,.92-.01,1.76-.02,2.61-14.7,4.56-30.67,9.51-46.68,14.47C188.13,73,201.43,53.41,219.52,43.23ZM201.61,26.16a8.7,8.7,0,0,1,4.95,1.67c-23.79,11.19-49.29,39.39-60.06,95.7l-37.04,11.47C119.17,99.97,142,26.16,201.61,26.16Z"
      />
      <path
        fill="#5E8E3E"
        d="M383.92,100.1c-2-.13-37.23-2.71-37.23-2.71s-24.69-24.51-27.45-27.27a6.61,6.61,0,0,0-3.83-1.73L292.84,443.66l136.12-29.41S388.69,106.05,388.32,104.09A4.66,4.66,0,0,0,383.92,100.1Z"
      />
      <path
        fill="#FFFFFF"
        d="M248.6,169.78l-16.79,49.94s-14.71-7.85-32.74-7.85c-26.43,0-27.76,16.59-27.76,20.77,0,22.81,59.46,31.55,59.46,84.97,0,42.05-26.66,69.12-62.61,69.12-43.14,0-65.21-26.85-65.21-26.85l11.55-38.18s22.69,19.49,41.85,19.49a17,17,0,0,0,17.7-17.16c0-29.75-48.79-31.08-48.79-79.97,0-41.16,29.55-81,89.18-81C238.81,162.93,248.6,169.78,248.6,169.78Z"
      />
    </svg>
  );
}

/**
 * Integrations page (seller-only).
 *
 * Lets any seller connect their own Shopify store via the Custom App + token
 * method: they paste their shop domain + Admin API access token + API secret,
 * Closwiz verifies the credentials, auto-registers the orders/create webhook,
 * and from then on every new Shopify order is imported into the Orders page as
 * a *pending* order (no automatic WhatsApp message — the seller stays in
 * control). All brain calls are tenant-scoped via shopifyApi (X-Seller-Id).
 *
 * Secrets are never round-tripped to the client: the brain returns only the
 * last-4 hints (access_token_hint / api_secret_hint) so the seller can confirm
 * which credentials are stored without re-exposing them.
 */
export function Integrations() {
  const { t } = useTranslation();
  const toast = useToast();

  const [status, setStatus] = useState<ShopifyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Connect form
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // When connected, the form is hidden behind a status panel until the seller
  // explicitly chooses to update their credentials.
  const [editing, setEditing] = useState(false);

  // Disconnect confirmation
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Collapsible help
  const [howOpen, setHowOpen] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await shopifyApi.getStatus();
      setStatus(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message || t('integrations.loadError', 'Could not load integrations'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const integration = status?.integration;
  const isConnected = !!integration?.connected;
  // Show the connect form when not connected, or when the seller chose to
  // update their stored credentials.
  const showForm = !isConnected || editing;

  function resetForm() {
    setShopDomain('');
    setAccessToken('');
    setApiSecret('');
    setShowToken(false);
    setShowSecret(false);
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    const domain = shopDomain.trim();
    const token = accessToken.trim();
    const secret = apiSecret.trim();
    if (!domain || !token || !secret) {
      toast.error(
        t('integrations.shopify.connectError', 'Connection failed'),
        t('integrations.shopify.missingFields', 'Domain, access token and API secret are all required'),
      );
      return;
    }
    setConnecting(true);
    try {
      const res = await shopifyApi.connect({
        shop_domain: domain,
        access_token: token,
        api_secret: secret,
      });
      if (res.webhook_warning) {
        toast.warning(
          t('integrations.shopify.webhookWarningTitle', 'Webhook not auto-registered'),
          res.webhook_warning,
        );
      } else {
        toast.success(
          t('integrations.shopify.connected', 'Shopify store connected'),
          res.shop_name,
        );
      }
      resetForm();
      setEditing(false);
      // Reflect the freshly-saved integration returned by connect, then
      // refetch the canonical status (webhook flags, timestamps).
      setStatus((prev) =>
        prev ? { ...prev, integration: res.integration, webhook_url: res.webhook_url } : prev,
      );
      await load(true);
    } catch (e) {
      toast.error(
        t('integrations.shopify.connectError', 'Connection failed'),
        (e as Error).message,
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await shopifyApi.disconnect();
      toast.success(t('integrations.shopify.disconnected', 'Shopify disconnected'));
      setConfirmOpen(false);
      setEditing(false);
      resetForm();
      await load(true);
    } catch (e) {
      toast.error(
        t('integrations.shopify.disconnectError', 'Could not disconnect'),
        (e as Error).message,
      );
    } finally {
      setDisconnecting(false);
    }
  }

  async function copyWebhook() {
    const url = status?.webhook_url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.info(t('integrations.copied', 'Copied to clipboard'));
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  function formatDate(iso?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }

  const statusLabel = !isConnected
    ? t('integrations.shopify.statusDisconnected', 'Not connected')
    : integration?.status === 'error'
      ? t('integrations.shopify.statusError', 'Attention required')
      : t('integrations.shopify.statusConnected', 'Connected');
  const statusKind = !isConnected ? 'off' : integration?.status === 'error' ? 'error' : 'on';

  return (
    <div className="integrations-page">
      <PageHeader
        title={t('integrations.title', 'Integrations')}
        subtitle={t('integrations.subtitle', 'Connect external tools so orders flow into Closwiz automatically.')}
      />

      {loadError && (
        <div className="integ-banner integ-banner-err">
          <AlertTriangle size={18} /> {loadError}
        </div>
      )}

      <section className="integ-card">
        {/* ── Card header ─────────────────────────────────────────── */}
        <header className="integ-card-head">
          <div className="integ-card-brand">
            <span className="integ-logo integ-logo-shopify">
              <ShopifyLogo size={28} />
            </span>
            <div>
              <h2 className="integ-card-title">{t('integrations.shopify.name', 'Shopify')}</h2>
              <p className="integ-card-tagline">
                {t('integrations.shopify.tagline', 'Auto-import your Shopify orders as pending orders in Closwiz.')}
              </p>
            </div>
          </div>
          <span className={`integ-status integ-status-${statusKind}`}>
            <span className="integ-status-dot" />
            {statusLabel}
          </span>
        </header>

        {loading ? (
          <div className="integ-loading">
            <Loader2 size={22} className="integ-spin" />
          </div>
        ) : (
          <>
            {/* ── Connected status panel ──────────────────────────── */}
            {isConnected && !editing && integration && (
              <div className="integ-status-panel">
                <dl className="integ-facts">
                  <div className="integ-fact">
                    <dt>{t('integrations.shopify.shop', 'Store')}</dt>
                    <dd className="integ-mono">{integration.shop_domain}</dd>
                  </div>
                  <div className="integ-fact">
                    <dt>{t('integrations.shopify.accessToken', 'Admin API access token')}</dt>
                    <dd className="integ-mono">{integration.access_token_hint}</dd>
                  </div>
                  <div className="integ-fact">
                    <dt>{t('integrations.shopify.apiSecret', 'API secret key')}</dt>
                    <dd className="integ-mono">{integration.api_secret_hint}</dd>
                  </div>
                  <div className="integ-fact">
                    <dt>{t('integrations.shopify.lastOrder', 'Last order received')}</dt>
                    <dd>
                      {integration.last_order_at
                        ? formatDate(integration.last_order_at)
                        : t('integrations.shopify.lastOrderNever', 'No orders imported yet')}
                    </dd>
                  </div>
                </dl>

                {/* Webhook health */}
                <div
                  className={`integ-webhook ${
                    integration.webhook_registered ? 'is-ok' : 'is-pending'
                  }`}
                >
                  {integration.webhook_registered ? (
                    <>
                      <CheckCircle2 size={18} />
                      <span>{t('integrations.shopify.webhookRegistered', 'Order webhook active')}</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={18} />
                      <div>
                        <span>{t('integrations.shopify.webhookPending', 'Order webhook not registered yet')}</span>
                        {!status?.public_url_configured && (
                          <p className="integ-webhook-hint">
                            {t(
                              'integrations.shopify.webhookPublicHint',
                              'Set PUBLIC_BASE_URL to a public https URL (or run a tunnel) so Closwiz can register the orders webhook automatically.',
                            )}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Webhook endpoint (copyable — for manual setup if needed) */}
                {status?.webhook_url && (
                  <div className="integ-webhook-url">
                    <span className="integ-eyebrow">
                      {t('integrations.shopify.webhookLabel', 'Webhook endpoint')}
                    </span>
                    <div className="integ-copy-row">
                      <code className="integ-mono">{status.webhook_url}</code>
                      <button type="button" className="integ-icon-btn" onClick={copyWebhook}>
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                )}

                {integration.last_error && (
                  <div className="integ-banner integ-banner-err integ-last-error">
                    <AlertTriangle size={16} />
                    <span>
                      <strong>{t('integrations.shopify.lastError', 'Last error')}:</strong>{' '}
                      {integration.last_error}
                    </span>
                  </div>
                )}

                <div className="integ-actions">
                  <button type="button" className="integ-btn-secondary" onClick={() => setEditing(true)}>
                    <Link2 size={16} /> {t('integrations.shopify.reconnect', 'Update credentials')}
                  </button>
                  <button type="button" className="integ-btn-danger" onClick={() => setConfirmOpen(true)}>
                    <Link2Off size={16} /> {t('integrations.shopify.disconnect', 'Disconnect')}
                  </button>
                  <button
                    type="button"
                    className="integ-icon-btn integ-refresh"
                    onClick={() => load(true)}
                    disabled={refreshing}
                    aria-label="refresh"
                  >
                    <RefreshCw size={15} className={refreshing ? 'integ-spin' : ''} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Connect / update form ───────────────────────────── */}
            {showForm && (
              <form className="integ-form" onSubmit={handleConnect}>
                <label className="integ-field">
                  <span className="integ-label">{t('integrations.shopify.shopDomain', 'Store domain')}</span>
                  <input
                    type="text"
                    className="integ-input integ-mono"
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    placeholder={t('integrations.shopify.shopDomainPlaceholder', 'your-store.myshopify.com')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={connecting}
                  />
                </label>

                <label className="integ-field">
                  <span className="integ-label">{t('integrations.shopify.accessToken', 'Admin API access token')}</span>
                  <div className="integ-input-wrap">
                    <input
                      type={showToken ? 'text' : 'password'}
                      className="integ-input integ-mono"
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      placeholder={t('integrations.shopify.accessTokenPlaceholder', 'shpat_…')}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={connecting}
                    />
                    <button
                      type="button"
                      className="integ-reveal"
                      onClick={() => setShowToken((v) => !v)}
                      tabIndex={-1}
                      aria-label={showToken ? 'hide' : 'show'}
                    >
                      {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>

                <label className="integ-field">
                  <span className="integ-label">{t('integrations.shopify.apiSecret', 'API secret key')}</span>
                  <div className="integ-input-wrap">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      className="integ-input integ-mono"
                      value={apiSecret}
                      onChange={(e) => setApiSecret(e.target.value)}
                      placeholder={t('integrations.shopify.apiSecretPlaceholder', "Your custom app's API secret")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={connecting}
                    />
                    <button
                      type="button"
                      className="integ-reveal"
                      onClick={() => setShowSecret((v) => !v)}
                      tabIndex={-1}
                      aria-label={showSecret ? 'hide' : 'show'}
                    >
                      {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>

                <div className="integ-actions">
                  <button type="submit" className="integ-btn-primary" disabled={connecting}>
                    {connecting ? (
                      <>
                        <Loader2 size={16} className="integ-spin" />
                        {t('integrations.shopify.connecting', 'Connecting…')}
                      </>
                    ) : (
                      <>
                        <Link2 size={16} />
                        {isConnected
                          ? t('integrations.shopify.reconnect', 'Update credentials')
                          : t('integrations.shopify.connect', 'Connect store')}
                      </>
                    )}
                  </button>
                  {isConnected && editing && (
                    <button
                      type="button"
                      className="integ-btn-secondary"
                      onClick={() => {
                        setEditing(false);
                        resetForm();
                      }}
                      disabled={connecting}
                    >
                      {t('integrations.shopify.cancel', 'Cancel')}
                    </button>
                  )}
                </div>
              </form>
            )}

            {/* ── How-to guide (collapsible) ──────────────────────── */}
            <div className="integ-help">
              <button
                type="button"
                className={`integ-help-toggle ${howOpen ? 'is-open' : ''}`}
                onClick={() => setHowOpen((v) => !v)}
              >
                <ChevronDown size={16} className="integ-chevron" />
                {t('integrations.shopify.howTitle', 'How to connect your Shopify store')}
              </button>
              {howOpen && (
                <ol className="integ-steps">
                  <li>{t('integrations.shopify.howStep1', 'In Shopify admin, open Settings → Apps and sales channels → Develop apps.')}</li>
                  <li>{t('integrations.shopify.howStep2', 'Click "Create an app", name it "Closwiz", then open Configuration → Admin API integration.')}</li>
                  <li>{t('integrations.shopify.howStep3', 'Grant the read_orders scope and save.')}</li>
                  <li>{t('integrations.shopify.howStep4', 'Install the app, then copy the Admin API access token (shown once) and the API secret key.')}</li>
                  <li>{t('integrations.shopify.howStep5', 'Paste the store domain, token and secret here, then click Connect.')}</li>
                </ol>
              )}
            </div>

            {/* ── Behavior note ───────────────────────────────────── */}
            <div className="integ-behavior">
              <h4>{t('integrations.shopify.behaviorTitle', 'What happens next')}</h4>
              <p>
                {t(
                  'integrations.shopify.behaviorBody',
                  'Every new Shopify order is imported into your Orders page as a pending order (and pushed to your Google Sheet if configured). No WhatsApp message is sent automatically — you stay in control.',
                )}
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── Disconnect confirmation modal ─────────────────────────── */}
      {confirmOpen && (
        <div className="integ-modal-backdrop" onClick={() => !disconnecting && setConfirmOpen(false)}>
          <div className="integ-modal" onClick={(e) => e.stopPropagation()}>
            <header className="integ-modal-head">
              <h3>{t('integrations.shopify.confirmDisconnectTitle', 'Disconnect Shopify?')}</h3>
              <button
                type="button"
                className="integ-icon-btn"
                onClick={() => setConfirmOpen(false)}
                disabled={disconnecting}
                aria-label="close"
              >
                <X size={18} />
              </button>
            </header>
            <p className="integ-modal-body">
              {t(
                'integrations.shopify.confirmDisconnectBody',
                'Closwiz will stop importing orders and your stored credentials will be deleted. You can reconnect anytime.',
              )}
            </p>
            <div className="integ-actions integ-modal-actions">
              <button
                type="button"
                className="integ-btn-secondary"
                onClick={() => setConfirmOpen(false)}
                disabled={disconnecting}
              >
                {t('integrations.shopify.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="integ-btn-danger"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <>
                    <Loader2 size={16} className="integ-spin" />
                    {t('integrations.shopify.disconnecting', 'Disconnecting…')}
                  </>
                ) : (
                  <>
                    <Trash2 size={16} />
                    {t('integrations.shopify.confirmDisconnectConfirm', 'Yes, disconnect')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
