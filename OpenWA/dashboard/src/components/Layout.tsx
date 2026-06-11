import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Smartphone,
  Webhook,
  Key,
  FileText,
  LogOut,
  Send,
  Server,
  Puzzle,
  ShoppingBag,
  CalendarClock,
  MessagesSquare,
  Plug,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Languages,
  UserCheck,
  Settings2,
  Building2,
  Zap,
  CreditCard,
  Workflow,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { type UserRole } from '../hooks/useRole';
import { useOrganization, PLAN_LABELS } from '../hooks/useOrganization';
import { SessionSwitcher } from './SessionSwitcher';
import { supportedLanguages, type SupportedLanguage } from '../i18n';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

// Each nav item declares which audience can see it. The dashboard now has
// two very different surfaces:
//   - 'seller'  → the shop owner. Sees only what they need: dashboard,
//                 their Bot Funnel, their WhatsApp pairing, their logs.
//   - 'admin'   → platform owner. Sees the seller surfaces (read-only-ish)
//                 plus the cross-tenant control plane: Approvals,
//                 System Settings, API Keys, Plugins, Infrastructure…
//   - 'both'    → screen makes sense for either role.
const allNavItems = [
  // — Admin first (most-used admin pages at the top of the rail) —
  { to: '/approvals',           icon: UserCheck,    key: 'approvals' as const,           audience: 'admin' as const,  fallbackLabel: 'Approvals' },
  { to: '/admin/subscriptions', icon: CreditCard,   key: 'adminSubscriptions' as const,  audience: 'admin' as const,  fallbackLabel: 'Subscriptions' },
  { to: '/system-settings',     icon: Settings2,    key: 'systemSettings' as const,      audience: 'admin' as const,  fallbackLabel: 'System Settings' },

  // — Shared —
  { to: '/',                icon: LayoutDashboard, key: 'dashboard' as const,      audience: 'both' as const },
  { to: '/sessions',        icon: Smartphone,      key: 'sessions' as const,       audience: 'both' as const },

  // — Seller-only (admin doesn't have these — they're per-seller). The
  //   sales surface is split into TWO strictly separated sections so a
  //   seller never sees physical products and bookable services mixed:
  //   E-commerce COD lists only kind='product'; Services & Réservations
  //   lists only kind='service'. Both routes render BotFunnel with a
  //   fixed `kind` (see App.tsx). —
  { to: '/funnel',          icon: ShoppingBag,     key: 'ecommerce' as const,      audience: 'seller' as const, fallbackLabel: '📦 E-commerce COD' },
  { to: '/services',        icon: CalendarClock,   key: 'services' as const,       audience: 'seller' as const, fallbackLabel: '📅 Services & Réservations' },
  { to: '/automation',      icon: Workflow,        key: 'automation' as const,     audience: 'seller' as const, fallbackLabel: 'Automation' },
  { to: '/conversations',   icon: MessagesSquare,  key: 'conversations' as const,  audience: 'seller' as const, fallbackLabel: 'Conversations' },
  { to: '/integrations',    icon: Plug,            key: 'integrations' as const,   audience: 'seller' as const, fallbackLabel: 'Integrations' },
  { to: '/billing',         icon: CreditCard,      key: 'billing' as const,        audience: 'seller' as const, fallbackLabel: 'Billing' },

  // — Admin operations —
  { to: '/webhooks',        icon: Webhook,         key: 'webhooks' as const,       audience: 'admin' as const },
  { to: '/api-keys',        icon: Key,             key: 'apiKeys' as const,        audience: 'admin' as const },
  { to: '/message-tester',  icon: Send,            key: 'messageTester' as const,  audience: 'admin' as const },
  { to: '/infrastructure',  icon: Server,          key: 'infrastructure' as const, audience: 'admin' as const },
  { to: '/plugins',         icon: Puzzle,          key: 'plugins' as const,        audience: 'admin' as const },

  // — Logs are useful for both —
  { to: '/logs',            icon: FileText,        key: 'logs' as const,           audience: 'both' as const },
];

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);
  const navigate = useNavigate();
  // Organization + billing snapshot for the top bar (plan badge,
  // tokens counter, currency). Admin context has no seller_id, so the
  // hook returns the placeholder state and the top bar stays minimal.
  const org = useOrganization();

  // Trial countdown for the top-bar pill + badge. Mirrors Billing.tsx:
  // the brain ends the trial on TRIAL_DAYS elapsed OR
  // TRIAL_CONVERSATIONS_CAP conversations, whichever hits first.
  const trialCap = org.trial_conversations_cap || 30;
  const trialUsed = Math.min(org.trial_conversations_used, trialCap);
  const trialPct = trialCap > 0
    ? Math.min(100, Math.round((100 * org.trial_conversations_used) / trialCap))
    : 0;
  const trialEnded = org.is_trial
    && (org.trial_days_left <= 0 || org.trial_conversations_used >= trialCap);
  const trialNearEnd = org.is_trial && !trialEnded
    && (org.trial_days_left <= 1 || trialPct >= 80);

  const navItems = allNavItems.filter(item => {
    if (item.audience === 'both') return true;
    if (item.audience === 'admin') return userRole === 'admin';
    // seller-only items hidden from admin
    return userRole !== 'admin';
  });

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0] as SupportedLanguage;
  // Short button labels in each language's own script — the operator
  // sees an instantly recognisable cue even when the rest of the UI is
  // mid-translation. The dropdown shows the full native name below.
  const languageButtonLabels: Record<SupportedLanguage, string> = {
    en: 'EN',
    fr: 'FR',
    ar: 'ع',
  };
  // Full native names shown inside the dropdown so the operator picks
  // their preferred locale in its own language ("Français" not "French").
  const languageNativeNames: Record<SupportedLanguage, string> = {
    en: 'English',
    fr: 'Français',
    ar: 'العربية',
  };
  const pickLanguage = (lang: SupportedLanguage) => {
    void i18n.changeLanguage(lang);
    setLangMenuOpen(false);
  };
  const languageLabel = languageButtonLabels[currentLang] || 'EN';
  const isRtl = currentLang === 'ar';

  // Close the language dropdown on outside-click. We listen at the
  // document level (mousedown so the click that opened the menu doesn't
  // immediately re-close it) and check whether the click landed inside
  // the wrapper we own.
  useEffect(() => {
    if (!langMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!langMenuRef.current) return;
      if (!langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setLangMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [langMenuOpen]);

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <img src="/closwiz_logo.svg" alt="Closwiz" className="sidebar-logo" />
            <span className="brand-name">{t('common.appName')}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <img src="/closwiz_logo.svg" alt="Closwiz" className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{t('common.appName')}</span>
              <span className="brand-subtitle">{t('common.appSubtitle')}</span>
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={toggleCollapse}
            title={isCollapsed ? t('common.expand') : t('common.collapse')}
            aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
          >
            {isCollapsed
              ? (isRtl ? <ChevronLeft size={16} /> : <ChevronRight size={16} />)
              : (isRtl ? <ChevronRight size={16} /> : <ChevronLeft size={16} />)}
          </button>
        )}

        <nav className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, key, fallbackLabel }) => {
            // Some nav items (e.g. the leadecombot Bot Funnel) aren't in
            // the i18n bundle yet — i18next returns the key as a string
            // in that case. Fall back to the hard-coded label when the
            // translation is unchanged from the key.
            const translationKey = `nav.${key}`;
            const translated = t(translationKey);
            const label = translated === translationKey && fallbackLabel
              ? fallbackLabel
              : translated;
            return (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                end={to === '/'}
                onClick={handleNavClick}
                title={isCollapsed ? label : undefined}
              >
                <Icon size={20} />
                {!isCollapsed && <span>{label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="lang-menu-wrap" ref={langMenuRef}>
            <button
              className={`theme-toggle-btn lang-menu-trigger ${langMenuOpen ? 'is-open' : ''}`}
              onClick={() => setLangMenuOpen((v) => !v)}
              title={t('common.language')}
              aria-label={t('common.language')}
              aria-haspopup="menu"
              aria-expanded={langMenuOpen}
            >
              <Languages size={18} />
              {!isCollapsed && <span>{languageLabel}</span>}
            </button>
            {langMenuOpen && (
              <div
                className={`lang-menu ${isCollapsed ? 'collapsed' : ''}`}
                role="menu"
              >
                {supportedLanguages.map((lang) => (
                  <button
                    key={lang}
                    role="menuitemradio"
                    aria-checked={lang === currentLang}
                    className={`lang-menu-item ${lang === currentLang ? 'is-active' : ''}`}
                    onClick={() => pickLanguage(lang)}
                  >
                    <span className="lang-menu-code">{languageButtonLabels[lang]}</span>
                    <span className="lang-menu-name">{languageNativeNames[lang]}</span>
                    {lang === currentLang && <span className="lang-menu-tick">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={t('theme.label', { value: themeLabel })}
          >
            <ThemeIcon size={18} />
            {!isCollapsed && <span>{themeLabel}</span>}
          </button>
          <button className="logout-btn" onClick={onLogout} title={isCollapsed ? t('common.logout') : undefined}>
            <LogOut size={20} />
            {!isCollapsed && <span>{t('common.logout')}</span>}
          </button>
        </div>
      </aside>

      <main className={`main-content ${isCollapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        {/* Qunvert-style top bar — org / plan / billing / currency /
            tokens-counter. Only rendered when the seller is logged in
            (admin context has no seller_id, hides the row). */}
        {userRole !== 'admin' && (
          <div className="topbar">
            <div className="topbar-left">
              <button className="topbar-org" type="button" disabled>
                <Building2 size={16} />
                {org.loading ? (
                  /* Hold a skeleton until the real plan loads — never flash the
                     default "Free" while /funnel/billing/usage is in flight. */
                  <>
                    <span className="topbar-skel topbar-skel-name" aria-hidden="true" />
                    <span className="topbar-skel topbar-skel-badge" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    <span className="topbar-org-name">
                      {org.organization_name || t('topbar.myOrganization', 'My Organization')}
                    </span>
                    <span className={`topbar-plan-badge ${org.is_trial ? 'is-trial' : `plan-${org.plan}`}`}>
                      {org.is_trial ? t('billing.tier.trial', 'Free trial') : PLAN_LABELS[org.plan]}
                    </span>
                  </>
                )}
              </button>
              <button
                className="topbar-billing"
                type="button"
                onClick={() => navigate('/billing')}
                title={t('topbar.billing', 'Billing')}
              >
                <CreditCard size={16} />
                <span>{t('topbar.billing', 'Billing')}</span>
              </button>
              {/* Scopes every seller surface (products, services, orders,
                  conversations) to ONE connected WhatsApp number — or "All
                  sessions". Renders nothing for sellers with <2 numbers. */}
              <SessionSwitcher />
            </div>
            <div className="topbar-right">
              {org.is_trial ? (
                /* Trial countdown — replaces the fair-use % pill while the
                   seller is on the free trial. The brain gates on days +
                   conversations, NOT tokens, so we show those instead. */
                <button
                  className={`topbar-tokens ${trialEnded || trialNearEnd ? 'is-near-cap' : ''}`}
                  type="button"
                  onClick={() => navigate('/billing')}
                  title={
                    trialEnded
                      ? t('topbar.trialEndedTooltip',
                         'Free trial ended — choose a plan to keep your bot replying.')
                      : t('topbar.trialTooltip',
                         'Free trial — {{days}}d left · {{used}}/{{cap}} conversations. Click to upgrade.',
                         { days: Math.max(0, org.trial_days_left), used: trialUsed, cap: trialCap })
                  }
                >
                  <Zap size={14} />
                  <span className="topbar-tokens-count">
                    {trialEnded
                      ? t('topbar.trialEnded', 'Trial ended')
                      : t('topbar.trialLabel', 'Trial')}
                  </span>
                  {!trialEnded && (
                    <span className="topbar-renewal">
                      {t('topbar.trialMeta', '{{days}}d · {{used}}/{{cap}}',
                         { days: Math.max(0, org.trial_days_left), used: trialUsed, cap: trialCap })}
                    </span>
                  )}
                </button>
              ) : (
                <button
                  className={`topbar-tokens ${org.fair_use_percent >= 90 ? 'is-near-cap' : ''}`}
                  type="button"
                  onClick={() => navigate('/billing')}
                  title={
                    !org.migration_applied
                      ? t('topbar.tokensMigrationPending',
                         'Billing — apply migration 0009/0010 to enable')
                      : org.tier === 'free'
                        ? t('topbar.upgradePrompt',
                           '{{percent}}% of free quota used. Click to upgrade.',
                           { percent: org.fair_use_percent })
                        : t('topbar.fairUseTooltip',
                           '{{percent}}% of monthly fair-use cap consumed · {{days}}d to renewal',
                           { percent: org.fair_use_percent, days: org.days_to_renewal })
                  }
                >
                  <Zap size={14} />
                  {/* Customer-facing label is intentionally a PERCENTAGE
                      of fair-use, NOT a raw token count, so the marketing
                      "unlimited chats" promise stays believable. */}
                  <span className="topbar-tokens-count">
                    {org.fair_use_percent}%
                  </span>
                  <span className="topbar-tokens-label">
                    {t('topbar.usedThisMonth', 'used')}
                  </span>
                  {org.days_to_renewal > 0 && (
                    <span className="topbar-renewal">
                      {' · '}{org.days_to_renewal}d
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
