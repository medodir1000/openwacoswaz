import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, AlertTriangle, X, Copy, Hourglass, Upload } from 'lucide-react';
import { useOrganization, formatMoney, PLAN_LABELS } from '../hooks/useOrganization';
import './Billing.css';

/**
 * Billing page — codhelix v2 subscription tiers in local currency.
 *
 * Layout:
 *   1. Current plan card (live: tier, fair-use %, renewal countdown)
 *   2. 2 tier cards (Pack 1 / Pack 2) with "Choose this plan" buttons
 *   3. Overage top-up cards (3 token packs) — secondary section
 *   4. Recent invoices list (subscriptions + token_packs)
 *
 * Customer-facing messaging stays "Unlimited products · Unlimited
 * chats". The fair-use percentage on the current-plan card is the
 * only place we hint at the token cap; raw token counts are never
 * shown to non-admin users.
 */

type Tier = {
  id: 'starter' | 'pro' | 'scale';
  label: string;
  amount_minor: number;
  currency: string;
  sessions_included: number;
  monthly_tokens: number;
};

type OveragePack = {
  id: string;
  label: string;
  amount_minor: number;
  currency: string;
  tokens: number;
};

interface PlansResponse {
  country_code: string;
  currency: string;
  provider: 'stripe' | 'cinetpay' | 'manual';
  free_tier: { sessions_included: number; monthly_tokens: number };
  tiers: Tier[];
  overage_packs: OveragePack[];
}

const sellerHeader = () => {
  const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
  return sellerId ? { 'X-Seller-Id': sellerId } : undefined;
};

interface PaymentMethod {
  method: string;
  label: string;
  details: string;
  instructions: string;
}
interface SubscribeRequestResponse {
  ok: boolean;
  request_id: string;
  status: string;
  tier: string;
  months: number;
  per_month_minor: number;
  total_minor: number;
  currency: string;
  country_code: string;
  payment_reference: string;
  payment_methods: PaymentMethod[];
  message: string;
}

export function Billing() {
  const { t } = useTranslation();
  const org = useOrganization();
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Subscribe modal state — opens when the user clicks "Choose this plan".
  const [modalTier, setModalTier] = useState<'starter' | 'pro' | 'scale' | null>(null);
  const [modalMonths, setModalMonths] = useState<number>(1);
  // After the user submits the request, we show payment instructions.
  const [requestResult, setRequestResult] = useState<SubscribeRequestResponse | null>(null);
  // Payment-proof upload (seller sends a screenshot of the transfer).
  const [proof, setProof] = useState<{ uploading: boolean; done: boolean; error: string | null }>(
    { uploading: false, done: false, error: null });

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/funnel/billing/plans', { headers: sellerHeader() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setPlans(await r.json());
      } catch (e) {
        setError((e as Error).message || 'plans fetch failed');
      }
    };
    void load();
  }, []);

  function openSubscribeModal(tierId: 'starter' | 'pro' | 'scale') {
    setModalTier(tierId);
    setModalMonths(1);
    setRequestResult(null);
    setProof({ uploading: false, done: false, error: null });
    setError(null);
  }
  function closeSubscribeModal() {
    setModalTier(null);
    setRequestResult(null);
    setProof({ uploading: false, done: false, error: null });
  }

  async function submitSubscriptionRequest() {
    if (!modalTier) return;
    setBusy(modalTier);
    setError(null);
    try {
      const r = await fetch('/funnel/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sellerHeader() || {}) },
        body: JSON.stringify({ tier: modalTier, months: modalMonths }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      setRequestResult(j as SubscribeRequestResponse);
      org.refresh();
    } catch (e) {
      setError((e as Error).message || 'subscribe failed');
    } finally {
      setBusy(null);
    }
  }

  async function submitPaymentProof(file: File) {
    if (!requestResult) return;
    setProof({ uploading: true, done: false, error: null });
    try {
      // 1) Upload the screenshot → public URL.
      const fd = new FormData();
      fd.append('file', file);
      const up = await fetch('/funnel/upload/product-image', {
        method: 'POST', headers: { ...(sellerHeader() || {}) }, body: fd,
      });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || !uj.url) throw new Error(uj.error || `Upload failed (HTTP ${up.status})`);
      // 2) Attach it to the pending subscription request.
      const at = await fetch('/funnel/billing/payment-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sellerHeader() || {}) },
        body: JSON.stringify({
          payment_reference: requestResult.payment_reference,
          payment_proof_url: uj.url,
        }),
      });
      const aj = await at.json().catch(() => ({}));
      if (!at.ok) throw new Error(aj.error || `HTTP ${at.status}`);
      setProof({ uploading: false, done: true, error: null });
    } catch (e) {
      setProof({ uploading: false, done: false, error: (e as Error).message });
    }
  }

  async function copyReference(ref: string) {
    try {
      await navigator.clipboard.writeText(ref);
      setFlash({ kind: 'ok', msg: t('billing.referenceCopied', 'Reference copied.') });
      setTimeout(() => setFlash(null), 2500);
    } catch {
      /* ignore */
    }
  }

  const isAtCap = org.fair_use_percent >= 100;
  const isNearCap = org.fair_use_percent >= 80;

  // Trial progress (self-serve signups). The brain ends the trial on
  // whichever hits first: TRIAL_DAYS elapsed OR TRIAL_CONVERSATIONS_CAP
  // distinct conversations — so we surface both. trialEnded mirrors the
  // brain's "bot goes silent until upgrade" state.
  const trialCap = org.trial_conversations_cap || 30;
  const trialUsed = Math.min(org.trial_conversations_used, trialCap);
  const trialPct = trialCap > 0
    ? Math.min(100, Math.round((100 * org.trial_conversations_used) / trialCap))
    : 0;
  const trialEnded = org.is_trial
    && (org.trial_days_left <= 0 || org.trial_conversations_used >= trialCap);
  const trialNearEnd = org.is_trial && !trialEnded
    && (org.trial_days_left <= 1 || trialPct >= 80);

  return (
    <div className="billing-page">
      <header className="billing-header">
        <h1>{t('billing.title', 'Billing & plans')}</h1>
        <p className="billing-subtitle">
          {t('billing.subtitle',
             'Pay in your local currency. Cancel any time. Unlimited products and chats included on every paid plan.')}
        </p>
      </header>

      {/* ── Current plan / trial card ─────────────────────────────── */}
      {org.is_trial ? (
        <section className={`billing-current is-trial ${trialEnded ? 'is-at-cap' : trialNearEnd ? 'is-near-cap' : ''}`}>
          <div className="billing-current-row">
            <div>
              <p className="billing-eyebrow">{t('billing.trial.eyebrow', 'Your free trial')}</p>
              <h2 className="billing-current-tier">{t('billing.tier.trial', 'Free trial')}</h2>
              <p className="billing-current-meta">
                {t('billing.trial.meta', '1 WhatsApp session · full bot, no feature locks')}
              </p>
            </div>
            <div className="billing-renewal">
              <p className="billing-eyebrow">
                {trialEnded ? t('billing.trial.endedShort', 'Trial ended') : t('billing.trial.timeLeft', 'Time left')}
              </p>
              <p className="billing-renewal-days">{Math.max(0, org.trial_days_left)}</p>
              <p className="billing-renewal-label">{t('billing.days', 'days')}</p>
            </div>
          </div>
          <div className="billing-fair-use">
            <div className="billing-fair-use-track">
              <div className="billing-fair-use-fill" style={{ width: `${trialPct}%` }} />
            </div>
            <p className="billing-fair-use-label">
              {trialEnded
                ? t('billing.trial.ended',
                    'Your free trial has ended. Choose a plan below to keep your bot replying.')
                : t('billing.trial.conversations',
                    '{{used}} of {{cap}} trial conversations used',
                    { used: trialUsed, cap: trialCap })}
            </p>
          </div>
        </section>
      ) : (
        <section className={`billing-current ${isAtCap ? 'is-at-cap' : isNearCap ? 'is-near-cap' : ''}`}>
          <div className="billing-current-row">
            <div>
              <p className="billing-eyebrow">{t('billing.currentPlan', 'Current plan')}</p>
              <h2 className="billing-current-tier">
                {PLAN_LABELS[org.plan] || PLAN_LABELS.free}
              </h2>
              <p className="billing-current-meta">
                {t('billing.sessionsIncluded',
                   '{{count}} WhatsApp sessions · unlimited products · unlimited chats',
                   { count: org.sessions_included })}
              </p>
            </div>
            {org.tier !== 'free' && org.days_to_renewal > 0 && (
              <div className="billing-renewal">
                <p className="billing-eyebrow">{t('billing.renewsIn', 'Renews in')}</p>
                <p className="billing-renewal-days">{org.days_to_renewal}</p>
                <p className="billing-renewal-label">{t('billing.days', 'days')}</p>
              </div>
            )}
          </div>
          <div className="billing-fair-use">
            <div className="billing-fair-use-track">
              <div className="billing-fair-use-fill" style={{ width: `${Math.min(100, org.fair_use_percent)}%` }} />
            </div>
            <p className="billing-fair-use-label">
              {isAtCap
                ? t('billing.atCap',
                    'Fair-use cap reached. Top up below to keep the bot replying.')
                : t('billing.fairUseUsed',
                    '{{percent}}% of this month\'s fair-use consumed',
                    { percent: org.fair_use_percent })}
            </p>
          </div>
        </section>
      )}

      {/* ── Error + flash banners ─────────────────────────────────── */}
      {error && (
        <div className="billing-banner billing-banner-err">
          <AlertTriangle size={18} /> {error}
        </div>
      )}
      {flash && (
        <div className={`billing-banner billing-banner-${flash.kind}`}>
          <Check size={18} /> {flash.msg}
        </div>
      )}

      {/* ── 2 tier cards ──────────────────────────────────────────── */}
      <section className="billing-section">
        <h2>{t('billing.choosePlanHeader', 'Choose your plan')}</h2>
        {!plans && <p className="billing-muted">{t('common.loading', 'Loading...')}</p>}
        {plans && (
          <div className="billing-tiers">
            {plans.tiers.map((tier) => {
              const isCurrent = org.tier === tier.id;
              const labelKey = `billing.tier.${tier.id}` as const;
              return (
                <div key={tier.id} className={`billing-tier-card tier-${tier.id} ${isCurrent ? 'is-current' : ''}`}>
                  <div className="billing-tier-head">
                    <h3>{t(labelKey, tier.label)}</h3>
                    {isCurrent && (
                      <span className="billing-tier-current">
                        {t('billing.activeBadge', 'Active')}
                      </span>
                    )}
                  </div>
                  <p className="billing-tier-price">
                    <span className="billing-tier-amount">{formatMoney(tier.amount_minor, tier.currency)}</span>
                    <span className="billing-tier-period">{t('billing.perMonth', '/ month')}</span>
                  </p>
                  <ul className="billing-tier-features">
                    <li>
                      <Check size={16} />
                      {t('billing.featureSessions',
                         '{{count}} WhatsApp numbers',
                         { count: tier.sessions_included })}
                    </li>
                    <li><Check size={16} />{t('billing.featureProducts', 'Unlimited products & services')}</li>
                    <li><Check size={16} />{t('billing.featureChats', 'Unlimited chats')}</li>
                    <li><Check size={16} />{t('billing.featureExcel', 'Excel + Google Sheets export')}</li>
                    <li><Check size={16} />{t('billing.featureLanguages', 'Darija, French, Arabic auto-detect')}</li>
                    <li><Check size={16} />{t('billing.featureSupport', 'Priority support')}</li>
                  </ul>
                  <button
                    className="billing-tier-cta"
                    onClick={() => openSubscribeModal(tier.id)}
                    disabled={isCurrent}
                  >
                    {isCurrent
                      ? t('billing.currentBadge', 'Your plan')
                      : t('billing.choosePlan', 'Choose this plan')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {plans && (
          <p className="billing-currency-note">
            {t('billing.currencyNote',
               'Prices shown in {{currency}} for {{country}}. Pay via {{provider}}.',
               { currency: plans.currency, country: plans.country_code,
                 // Stripe/CinetPay were never wired — payment is manual everywhere
                 // (MA/EG → bank transfer; WAEMU/Guinea/CEMAC → Orange Money). Show
                 // the real method, not the would-be processor.
                 provider: plans.provider === 'stripe' ? 'bank transfer' : 'Orange Money' })}
          </p>
        )}
      </section>

      {/* ── Subscribe modal — months picker + payment instructions ── */}
      {modalTier && plans && (() => {
        const tier = plans.tiers.find(t => t.id === modalTier);
        if (!tier) return null;
        const totalMinor = tier.amount_minor * modalMonths;
        return (
          <div className="billing-modal-backdrop" onClick={closeSubscribeModal}>
            <div className="billing-modal" onClick={(e) => e.stopPropagation()}>
              <header className="billing-modal-head">
                <h2>
                  {requestResult
                    ? t('billing.modal.titleConfirm', 'Effectuez le paiement')
                    : t('billing.modal.titleSelect', 'Souscrire à {{tier}}',
                        { tier: t(`billing.tier.${tier.id}` as const, tier.label) })}
                </h2>
                <button className="billing-modal-close" onClick={closeSubscribeModal}>
                  <X size={18} />
                </button>
              </header>

              {!requestResult && (
                <>
                  <p className="billing-modal-hint">
                    {t('billing.modal.hint',
                       'Choisissez le nombre de mois. Le paiement est manuel — votre administrateur active votre abonnement dès réception du virement.')}
                  </p>

                  <div className="billing-modal-months">
                    {[1, 3, 6, 12].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`billing-month-chip ${modalMonths === n ? 'is-on' : ''}`}
                        onClick={() => setModalMonths(n)}
                      >
                        {n} {t('billing.modal.month', { count: n, defaultValue_one: 'mois', defaultValue_other: 'mois' })}
                      </button>
                    ))}
                  </div>

                  <div className="billing-modal-summary">
                    <span>{t('billing.modal.totalLabel', 'Total à payer')}</span>
                    <span className="billing-modal-total">
                      {formatMoney(totalMinor, tier.currency)}
                    </span>
                  </div>

                  {error && (
                    <div className="billing-banner billing-banner-err">
                      <AlertTriangle size={16} /> {error}
                    </div>
                  )}

                  <button
                    className="billing-modal-submit"
                    onClick={submitSubscriptionRequest}
                    disabled={busy === modalTier}
                  >
                    {busy === modalTier
                      ? <><Loader2 size={16} className="spin" /> {t('common.loading', 'Loading...')}</>
                      : t('billing.modal.submit', 'Voir les instructions de paiement')}
                  </button>
                </>
              )}

              {requestResult && (
                <>
                  <p className="billing-modal-hint">{requestResult.message}</p>

                  <div className="billing-modal-summary">
                    <span>{t('billing.modal.totalLabel', 'Total à payer')}</span>
                    <span className="billing-modal-total">
                      {formatMoney(requestResult.total_minor, requestResult.currency)}
                    </span>
                  </div>

                  <div className="billing-reference">
                    <span className="billing-eyebrow">
                      {t('billing.modal.reference', 'Référence de paiement (à envoyer sur WhatsApp)')}
                    </span>
                    <div className="billing-reference-row">
                      <code className="billing-reference-code">
                        {requestResult.payment_reference}
                      </code>
                      <button
                        type="button"
                        className="billing-reference-copy"
                        onClick={() => copyReference(requestResult.payment_reference)}
                      >
                        <Copy size={14} /> {t('common.copy', 'Copy')}
                      </button>
                    </div>
                  </div>

                  <div className="billing-methods">
                    <span className="billing-eyebrow">
                      {t('billing.modal.methods', 'Moyens de paiement disponibles')}
                    </span>
                    {requestResult.payment_methods.map((m, idx) => (
                      <div key={idx} className="billing-method-card">
                        <h4>{m.label}</h4>
                        <div className="billing-method-details">
                          {m.details.split('\n').map((line, li) => {
                            const ci = line.indexOf(':');
                            const value = ci >= 0 ? line.slice(ci + 1).trim() : line.trim();
                            return (
                              <div key={li} className="billing-detail-row">
                                <span className="billing-detail-text">{line}</span>
                                {value && (
                                  <button
                                    type="button"
                                    className="billing-detail-copy"
                                    title={t('common.copy', 'Copier')}
                                    onClick={() => copyReference(value)}
                                  >
                                    <Copy size={13} />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <p className="billing-method-instructions">{m.instructions}</p>
                      </div>
                    ))}
                  </div>

                  {/* Payment proof — seller uploads a screenshot of the transfer. */}
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <span className="billing-eyebrow">
                      {t('billing.modal.proofTitle', 'Confirmer le paiement')}
                    </span>
                    {proof.done ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#16a34a', fontWeight: 600, fontSize: '0.85rem' }}>
                        <Check size={16} /> {t('billing.modal.proofDone', 'Preuve envoyée ✓ — en cours de vérification.')}
                      </div>
                    ) : (
                      <>
                        <label style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                          padding: '0.6rem 0.9rem', borderRadius: '10px', cursor: proof.uploading ? 'wait' : 'pointer',
                          background: '#16a34a', color: '#fff', fontWeight: 600, fontSize: '0.875rem',
                          opacity: proof.uploading ? 0.7 : 1,
                        }}>
                          {proof.uploading
                            ? <><Loader2 size={16} className="spin" /> {t('billing.modal.proofUploading', 'Envoi…')}</>
                            : <><Upload size={16} /> {t('billing.modal.proofUpload', "J'ai payé — envoyer la capture")}</>}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            style={{ display: 'none' }}
                            disabled={proof.uploading}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void submitPaymentProof(f); e.target.value = ''; }}
                          />
                        </label>
                        <p style={{ fontSize: '0.78rem', color: '#6b7280', lineHeight: 1.5, margin: 0 }}>
                          {t('billing.modal.proofHint', "Après le virement / Orange Money, envoyez une capture du reçu ici. L'admin active dès vérification.")}
                        </p>
                        {proof.error && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#dc2626', fontSize: '0.8rem' }}>
                            <AlertTriangle size={14} /> {proof.error}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="billing-status-pending">
                    <Hourglass size={16} />
                    {t('billing.modal.pendingAdmin',
                       'En attente d\'activation par l\'administrateur. Vous recevrez une notification WhatsApp dès que votre abonnement sera actif.')}
                  </div>

                  <button className="billing-modal-submit" onClick={closeSubscribeModal}>
                    {t('common.close', 'Fermer')}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
