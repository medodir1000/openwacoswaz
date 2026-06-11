import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock, Clock, ArrowRight } from 'lucide-react';
import type { AccessState } from '../hooks/useOrganization';

/**
 * Banner shown at the top of gated seller pages (Sessions, Products,
 * Services) when the free trial has ended. The brain ALSO hard-blocks the
 * underlying create endpoints (HTTP 402) — this is the friendly, proactive
 * explanation + a path to the plans.
 *
 *  • access.allowed         → renders nothing.
 *  • access.pending         → amber "request received, awaiting activation".
 *  • blocked (not pending)  → red "trial ended → choose a plan" + CTA.
 *
 * Self-contained inline styles (the dashboard is plain-CSS, no Tailwind on
 * these pages) using the Closwiz palette.
 */
export function AccessGate({ access }: { access: AccessState }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (!access || access.allowed) return null;
  const pending = access.pending;

  const tone = pending
    ? { bg: '#fffbeb', border: '#fde68a', fg: '#92400e', icon: '#d97706' }
    : { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b', icon: '#dc2626' };

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: '0.85rem',
        background: tone.bg, border: `1px solid ${tone.border}`,
        borderRadius: 12, padding: '0.85rem 1rem', marginBottom: '1rem',
      }}
    >
      <span style={{
        display: 'grid', placeItems: 'center', flexShrink: 0,
        width: 38, height: 38, borderRadius: 10,
        background: '#fff', color: tone.icon, border: `1px solid ${tone.border}`,
      }}>
        {pending ? <Clock size={20} /> : <Lock size={20} />}
      </span>

      <div style={{ flex: 1, minWidth: 0, color: tone.fg }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          {pending
            ? t('access.pendingTitle', 'Demande envoyée — en attente d’activation')
            : t('access.blockedTitle', 'Essai gratuit terminé')}
        </div>
        <div style={{ fontSize: '0.82rem', opacity: 0.9, marginTop: 2 }}>
          {pending
            ? t('access.pendingDesc', 'Votre paiement est en cours de vérification. L’accès sera débloqué dès l’activation par l’administrateur.')
            : t('access.blockedDesc', 'Choisissez un plan pour réactiver vos sessions WhatsApp, produits et services. L’accès est débloqué après validation du paiement.')}
        </div>
      </div>

      {!pending && (
        <button
          type="button"
          onClick={() => navigate('/billing')}
          style={{
            flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--primary)', color: '#fff',
            border: 'none', borderRadius: 10, padding: '0.55rem 0.9rem',
            fontSize: '0.83rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {t('access.cta', 'Choisir un plan')} <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

export default AccessGate;
