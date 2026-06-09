// Bot Funnel — leadecombot management surface embedded in the OpenWA
// dashboard. Talks to brain.py through /funnel/* (Vite proxy → :5001).
// Brain owns Supabase; the dashboard just renders. Single page with
// tabs so the operator manages products, sees orders/conversations,
// and tunes bot settings without leaving OpenWA.

import { useEffect, useMemo, useState, useRef, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '../hooks/useOrganization';
import { AccessGate } from '../components/AccessGate';
import * as XLSX from 'xlsx';
import {
  ShoppingBag,
  Tag,
  MessagesSquare,
  Settings as Cog,
  Plus,
  Trash2,
  Pencil,
  Save,
  X,
  Loader2,
  Image as ImageIcon,
  RefreshCw,
  Upload,
  AlertCircle,
  CheckCircle2,
  FileDown,
  CalendarClock,
  CalendarCheck,
  FileText,
  Images,
  ListChecks,
  Radio,
  CircleDollarSign,
  Megaphone,
  Copy,
} from 'lucide-react';
import './BotFunnel.css';
import { useServiceConfig, invalidateServiceConfig } from '../hooks/useServiceConfig';
import { BUSINESS_CATEGORY_OPTIONS, getServiceConfig } from '../config/serviceConfig';
import { useActiveSession, matchesSession } from '../hooks/useActiveSession';

// ── Types ────────────────────────────────────────────────────────────────
type ProductCountry = {
  id?: string;
  country_code: string;
  language_code: string;
  price: number;
  currency: string;
  price_tiers?: Record<string, number>;
  available?: boolean;
  translated_name?: string | null;
  translated_description?: string | null;
};

type Product = {
  id?: string;
  name: string;
  description: string | null;
  image_url: string | null;
  aliases: string[];
  status: 'active' | 'out_of_stock' | 'archived';
  sheets_webhook_url: string | null;
  // Migration 0006 — which WhatsApp sessions default to this product
  // when a customer messages them. Empty list = keyword-only routing.
  whatsapp_session_ids?: string[];
  // Migration 0007 — supplementary product images the bot sends to the
  // customer right after detecting the product (once per conversation).
  gallery_urls?: string[];
  // Migration 0008 — 'product' (physical goods, default) vs 'service'
  // (bookings, rentals, appointments — different bot flow).
  kind?: 'product' | 'service';
  // Migration 0012 — universal "Any Service" extraction schema. The bot
  // collects EXACTLY these fields before confirming a booking. Empty for
  // products and for services that never opened the builder.
  custom_fields?: CustomField[];
  product_countries?: ProductCountry[];
};

// Sales markets the platform prices in local currency — mirrors the brain's
// COUNTRY_TO_CURRENCY (api/brain.py). Picking a country auto-fills its local
// currency; the seller can still override via the currency dropdown.
const PRICING_COUNTRIES: { code: string; name: string; currency: string }[] = [
  { code: 'MA', name: 'Maroc',         currency: 'MAD' },
  { code: 'SN', name: 'Sénégal',       currency: 'XOF' },
  { code: 'CI', name: "Côte d'Ivoire", currency: 'XOF' },
  { code: 'BJ', name: 'Bénin',         currency: 'XOF' },
  { code: 'TG', name: 'Togo',          currency: 'XOF' },
  { code: 'ML', name: 'Mali',          currency: 'XOF' },
  { code: 'BF', name: 'Burkina Faso',  currency: 'XOF' },
  { code: 'NE', name: 'Niger',         currency: 'XOF' },
  { code: 'GW', name: 'Guinée-Bissau', currency: 'XOF' },
  { code: 'GN', name: 'Guinée',        currency: 'GNF' },
  { code: 'CM', name: 'Cameroun',      currency: 'XAF' },
  { code: 'GA', name: 'Gabon',         currency: 'XAF' },
  { code: 'CG', name: 'Congo',         currency: 'XAF' },
  { code: 'TD', name: 'Tchad',         currency: 'XAF' },
  { code: 'CF', name: 'Centrafrique',  currency: 'XAF' },
  { code: 'EG', name: 'Égypte',        currency: 'EGP' },
];
// Price currencies offered in the dropdown (USD = universal fallback).
const PRICING_CURRENCIES = ['MAD', 'XOF', 'GNF', 'XAF', 'EGP', 'USD'];

// A single field the bot must extract from the customer during a service
// conversation (migration 0012). `key` is a stable snake_case identifier
// the brain writes into pending_order_fields; `is_standard` flags the
// built-in Nom/Téléphone toggles vs. a seller-typed custom field.
type CustomFieldType = 'text' | 'phone' | 'number' | 'date' | 'choice';
type CustomField = {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  is_standard: boolean;
};

// Mirror of the brain's _slugify_field_key so the local model carries a
// meaningful snake_case key (→ becomes the Google-Sheet column header and
// the pending_order_fields key). The brain re-sanitises on save, so this
// is best-effort: accented Latin folds to ascii; a purely non-Latin label
// (e.g. Arabic) folds to '' and the brain assigns a field_N fallback.
function slugifyFieldKey(s: string): string {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

type WaSession = {
  id: string;          // OpenWA session UUID — stored on products
  name: string;        // "bot1", "bot12"
  phone: string;       // "212633753039"
  status: string;      // "ready" / "disconnected" / ...
};

type OrderRow = {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_city: string | null;
  country_code: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  currency: string;
  status: string;
  sheets_sync_status: string;
  created_at: string;
  // The order inherits its product's WhatsApp-session pins (brain embeds
  // `whatsapp_session_ids` in the products join) so the global session
  // switcher can scope orders to one number without a schema change.
  products: { name: string; kind?: string; whatsapp_session_ids?: string[] } | null;
};

type ConversationRow = {
  id: string;
  customer_jid: string;
  customer_phone: string | null;
  country_code: string | null;
  language_code: string | null;
  status: string;
  started_at: string;
  last_message_at: string;
  pending_order_fields: Record<string, unknown> | null;
  // Resolved from the conversation's detected product by the brain
  // (/funnel/conversations). Empty when no product was detected yet —
  // such a chat shows only under "All sessions".
  session_jids?: string[];
};

type SellerSettings = {
  id: string;
  business_name: string;
  default_language: string;
  country_codes: string[];
  business_category: string | null;
  tone_of_voice: string | null;
  bot_persona: string;
  daily_msg_cap: number;
  sheets_webhook_url: string | null;
  openwa_api_url: string | null;
  openwa_session_id: string | null;
  openwa_api_key_masked?: string;
};

const TABS = ['products', 'orders', 'conversations', 'settings'] as const;
type Tab = typeof TABS[number];

// Every /funnel/* call carries the current seller's id (stashed at login)
// so the brain knows which tenant to scope the read/write to. Without
// this, brain's single-seller fallback would silently return another
// seller's data once a second account signs up.
async function ffetch(path: string, init: RequestInit = {}) {
  const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  if (sellerId && !headers['X-Seller-Id']) headers['X-Seller-Id'] = sellerId;
  return fetch(path, { ...init, headers });
}

// ── Page ─────────────────────────────────────────────────────────────────
// The sales surface is split into TWO strictly separated sections, each
// rendering this component with a fixed `kind` (see App.tsx + Layout.tsx):
//   • kind='product' → "E-commerce COD"        — lists/creates kind='product'
//   • kind='service' → "Services & Réservations" — lists/creates kind='service'
// A seller NEVER sees the two mixed: the section decides the page title, the
// single Add button, which rows appear, and how the drawer is pre-configured.
export default function BotFunnel({ kind = 'product' }: { kind?: 'product' | 'service' }) {
  const [tab, setTab] = useState<Tab>('products');
  const { t } = useTranslation();
  // Vertical-aware tab wording still colours the Orders tab (columns, stats,
  // status labels via Feature C's serviceConfig). The Products tab + page
  // header come from the SECTION, not the vertical, so the two surfaces stay
  // unambiguously separated regardless of the seller's business_category.
  const { config, label } = useServiceConfig();
  const isService = kind === 'service';
  const ns = isService ? 'botFunnel.services' : 'botFunnel.ecommerce';

  const tabLabel = (tb: Tab): string => {
    if (tb === 'products') return t(`${ns}.tab`);
    if (tb === 'orders') return isService ? t(`${ns}.ordersTab`) : label(config.ordersTitle);
    return labelForTab(tb, t);
  };

  return (
    <div className="funnel-page">
      <header className="funnel-header">
        <div>
          <p className="funnel-eyebrow">{t(`${ns}.eyebrow`)}</p>
          <h1 className="funnel-title">{t(`${ns}.title`)}</h1>
          <p className="funnel-subtitle">{t(`${ns}.subtitle`)}</p>
        </div>
      </header>

      <nav className="funnel-tabs">
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            className={'funnel-tab' + (tb === tab ? ' is-active' : '')}
            onClick={() => setTab(tb)}
          >
            {iconForTab(tb, isService)} {tabLabel(tb)}
          </button>
        ))}
      </nav>

      <div className="funnel-body">
        {tab === 'products' && <ProductsTab kind={kind} />}
        {tab === 'orders' && <OrdersTab kind={kind} />}
        {tab === 'conversations' && <ConversationsTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

function iconForTab(t: Tab, isService = false) {
  const cls = 'funnel-icon';
  if (t === 'products') return isService ? <CalendarClock className={cls} /> : <Tag className={cls} />;
  if (t === 'orders') return isService ? <CalendarCheck className={cls} /> : <ShoppingBag className={cls} />;
  if (t === 'conversations') return <MessagesSquare className={cls} />;
  return <Cog className={cls} />;
}

function labelForTab(t: Tab, tt: (key: string) => string) {
  return {
    products: tt('botFunnel.tabs.products'),
    orders: tt('botFunnel.tabs.orders'),
    conversations: tt('botFunnel.tabs.conversations'),
    settings: tt('botFunnel.tabs.settings'),
  }[t];
}

// ─── Products / Services ───────────────────────────────────────────────────
// One component, two strictly separated modes driven by `kind`:
//   • kind='product' → E-commerce COD: only physical-goods rows, single
//                       "+ New product" button, drawer locked to product.
//   • kind='service' → Services & Réservations: only bookable-service rows,
//                       single "+ New service" button, drawer locked to
//                       service (shows the CustomFieldsEditor, no stock).
// Rows are filtered client-side by `kind` so the two surfaces never blend.
function ProductsTab({ kind }: { kind: 'product' | 'service' }) {
  const { t } = useTranslation();
  const { activeSessionId } = useActiveSession();
  const { access } = useOrganization();
  const isService = kind === 'service';
  const ns = isService ? 'botFunnel.services' : 'botFunnel.ecommerce';
  const [products, setProducts] = useState<Product[] | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const r = await ffetch('/funnel/products');
      const j = await r.json();
      setProducts(j.products || []);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleDelete(p: Product) {
    if (!p.id) return;
    if (!confirm(t('botFunnel.products.confirmArchive', { name: p.name }))) return;
    await ffetch(`/funnel/products/${p.id}`, { method: 'DELETE' });
    load();
  }

  // Strict separation: a row with no explicit kind is a legacy e-commerce
  // product (default 'product'), so it only ever shows in the E-commerce
  // section — never under Services. Then the global session switcher
  // narrows to one WhatsApp number: a product pinned to specific sessions
  // shows only under those, while an unpinned product (empty list) is
  // reachable on every number, so it stays visible under each (emptyIsAll).
  const visible = (products || [])
    .filter((p) => (p.kind || 'product') === kind)
    .filter((p) => matchesSession(p.whatsapp_session_ids, activeSessionId, true));
  const addLabel = t(`${ns}.addLabel`);

  return (
    <div>
      <AccessGate access={access} />
      <div className="funnel-row-between">
        <p className="funnel-help">{t(`${ns}.explainer`)}</p>
        <div className="funnel-actions">
          <button className="funnel-btn ghost" onClick={load} disabled={busy} type="button">
            {busy ? <Loader2 className="spin" /> : <RefreshCw />} {t('common.refresh')}
          </button>
          <button
            className="funnel-btn primary"
            onClick={() => setEditing(newProduct(kind))}
            type="button"
            title={access.allowed ? addLabel : t('access.blockedTitle', 'Essai gratuit terminé')}
            disabled={!access.allowed}
          >
            <Plus /> {addLabel}
          </button>
        </div>
      </div>

      {error && <div className="funnel-error">✗ {error}</div>}

      {!products && <p className="funnel-muted">{t('common.loading')}</p>}
      {products && visible.length === 0 && (
        <div className="funnel-empty">
          {isService ? <CalendarClock /> : <Tag />}
          <p>{t(`${ns}.empty`)}</p>
        </div>
      )}

      {products && visible.length > 0 && (
        <div className="funnel-products-grid">
          {visible.map((p) => (
            <div className="funnel-card" key={p.id}>
              <div className="funnel-card-img">
                {p.image_url
                  ? <img src={p.image_url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.2')} />
                  : <ImageIcon />}
              </div>
              <div className="funnel-card-body">
                <h3>{p.name || '(untitled)'}</h3>
                <p className="funnel-card-desc">{(p.description || '').slice(0, 140)}{(p.description || '').length > 140 ? '…' : ''}</p>
                <div className="funnel-card-meta">
                  {/* No kind pill here — the whole section IS one kind, so it
                      would be redundant noise on every card. */}
                  <span className={'pill ' + p.status}>{p.status}</span>
                  {p.aliases?.length ? <span className="pill">{t('botFunnel.products.pillAliases', { count: p.aliases.length })}</span> : null}
                  {p.product_countries?.length ? <span className="pill">{t('botFunnel.products.pillMarkets', { count: p.product_countries.length })}</span> : null}
                  {p.whatsapp_session_ids?.length
                    ? <span className="pill ok">{t('botFunnel.products.pillNumbers', { count: p.whatsapp_session_ids.length })}</span>
                    : null}
                  {p.sheets_webhook_url ? <span className="pill ok">{t('botFunnel.products.pillSheetLinked')}</span> : null}
                </div>
              </div>
              <div className="funnel-card-actions">
                <button className="funnel-btn icon" onClick={() => setEditing(p)} title="Edit"><Pencil /></button>
                <button className="funnel-btn icon danger" onClick={() => handleDelete(p)} title="Archive"><Trash2 /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ProductDrawer
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function newProduct(kind: 'product' | 'service' = 'product'): Product {
  return {
    name: '',
    description: '',
    image_url: '',
    aliases: [],
    status: 'active',
    kind,
    sheets_webhook_url: '',
    whatsapp_session_ids: [],
    gallery_urls: [],
    custom_fields: [],
    product_countries: [{ country_code: 'GN', language_code: 'fr', price: 0, currency: 'GNF', price_tiers: {}, available: true }],
  };
}

// ── Product edit drawer (slide-in form) ──────────────────────────────────
function ProductDrawer({ product, onClose, onSaved }: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Product>(product);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedAd, setCopiedAd] = useState(false);

  const isNew = !product.id;

  function set<K extends keyof Product>(k: K, v: Product[K]) {
    setDraft({ ...draft, [k]: v });
  }
  function setCountry(updates: Partial<ProductCountry>) {
    const pcs = draft.product_countries || [];
    const first = { ...(pcs[0] || newProduct().product_countries![0]), ...updates };
    setDraft({ ...draft, product_countries: [first, ...pcs.slice(1)] });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // WhatsApp routing is REQUIRED — a product pinned to no number can never
    // be reached by the bot. Block the save and tell the seller (their lang).
    if (!(draft.whatsapp_session_ids && draft.whatsapp_session_ids.length > 0)) {
      setError(t('botFunnel.drawer.whatsappRequiredError'));
      return;
    }
    setBusy(true);
    const pc = draft.product_countries?.[0];
    const payload = {
      name: draft.name,
      description: draft.description,
      image_url: draft.image_url,
      aliases: draft.aliases,
      status: draft.status,
      kind: draft.kind || 'product',
      sheets_webhook_url: draft.sheets_webhook_url || null,
      whatsapp_session_ids: draft.whatsapp_session_ids || [],
      gallery_urls:         draft.gallery_urls || [],
      // Only services carry an extraction schema; products always send []
      // so switching a row product→service→product can't leave stale fields.
      custom_fields: draft.kind === 'service' ? (draft.custom_fields || []) : [],
      country: pc ? {
        id: pc.id,
        country_code: pc.country_code,
        language_code: pc.language_code,
        price: pc.price,
        currency: pc.currency,
        price_tiers: pc.price_tiers || {},
      } : null,
    };
    try {
      const url = isNew ? '/funnel/products' : `/funnel/products/${draft.id}`;
      const r = await ffetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // 402 trial_expired carries a friendly `message`; prefer it over the code.
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const pc = draft.product_countries?.[0];
  const isService = draft.kind === 'service';
  // Kind-aware label helper: pick the product- or service-variant i18n key.
  const k = (prodKey: string, servKey: string, prodDef: string, servDef: string) =>
    isService ? t(servKey, servDef) : t(prodKey, prodDef);
  const optional = t('botFunnel.drawer.optional', 'optional');
  // Auto-generated Click-to-WhatsApp pre-filled message. Naming the product in
  // the customer's first message is the ONLY way the bot detects which product
  // an ad is about (the gateway exposes no Meta ad-referral), so we hand the
  // seller the exact text to paste into their FB/IG ad's pre-filled message.
  const adName = (draft.name || '').trim();
  const adPrefill = adName ? `Bonjour, je veux ${adName} 🛍️` : '';

  return (
    <div className="funnel-drawer-backdrop" onClick={onClose}>
      <div className="funnel-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="funnel-drawer-head">
          <div className="funnel-drawer-head-titles">
            <h2>
              {isNew
                ? (isService ? t('botFunnel.drawer.newService') : t('botFunnel.drawer.newProduct'))
                : (isService ? t('botFunnel.drawer.editService') : t('botFunnel.drawer.editProduct'))}
            </h2>
            <span className={`funnel-kind-badge ${isService ? 'is-service' : 'is-product'}`}>
              {isService
                ? t('botFunnel.drawer.kindBadgeService', '🛎 Service')
                : t('botFunnel.drawer.kindBadgeProduct', '📦 Product')}
            </span>
          </div>
          <button className="funnel-btn icon" onClick={onClose} type="button" disabled={busy} aria-label={t('botFunnel.drawer.cancel', 'Cancel')}><X /></button>
        </header>

        <form className="funnel-drawer-body" onSubmit={handleSubmit}>
          {/* ── Identity ─────────────────────────────────────────── */}
          <Section
            title={t('botFunnel.drawer.secIdentity', 'Identity')}
            icon={<Tag size={18} />}
            subtitle={t('botFunnel.drawer.secIdentitySub', 'How the bot recognizes this on the first message.')}
          >
            <Field label={t('botFunnel.drawer.nameLabel', 'Name')} required>
              <input className="funnel-input" value={draft.name} onChange={(e) => set('name', e.target.value)} required />
            </Field>
            <Field
              label={`${k('botFunnel.drawer.aliasesLabelProduct', 'botFunnel.drawer.aliasesLabelService', 'Product names & aliases', 'Service names & aliases')} · ${optional}`}
              hint={t('botFunnel.drawer.aliasesHint', 'Keywords / synonyms / misspellings the bot recognizes: biorein, bio rein, bio-rein…')}
            >
              <input
                className="funnel-input"
                value={(draft.aliases || []).join(', ')}
                onChange={(e) => set('aliases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                placeholder="biorein, bio rein, bio-rein"
              />
            </Field>
          </Section>

          {/* ── Description / bot prompt ─────────────────────────── */}
          <Section
            title={t('botFunnel.drawer.secDescription', 'Description / bot prompt')}
            icon={<FileText size={18} />}
            subtitle={t('botFunnel.drawer.secDescriptionSub', 'The text the bot reads when answering questions.')}
          >
            <Field
              label={t('botFunnel.drawer.descLabel', 'Description / Bot prompt')}
              hint={isService ? t('botFunnel.drawer.descHintService') : t('botFunnel.drawer.descHintProduct')}
            >
              <textarea className="funnel-input" rows={6} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />
            </Field>
          </Section>

          {/* ── Photos ───────────────────────────────────────────── */}
          <Section
            title={t('botFunnel.drawer.secPhotos', 'Photos')}
            icon={<Images size={18} />}
            subtitle={t('botFunnel.drawer.secPhotosSub', 'The main card image plus extra photos the bot can send.')}
          >
            <Field
              label={k('botFunnel.drawer.photoLabelProduct', 'botFunnel.drawer.photoLabelService', 'Product photo', 'Service photo')}
              hint={t('botFunnel.drawer.photoHint', 'Main image shown on the card. Drag a PNG/JPG/WEBP or click to pick one.')}
            >
              <ImageUploader value={draft.image_url || ''} onChange={(url) => set('image_url', url)} />
            </Field>
            <Field
              label={`${t('botFunnel.drawer.galleryLabel', 'Image gallery')} · ${optional}`}
              hint={t('botFunnel.drawer.galleryHint', 'Extra photos the bot sends right after detecting this (angles, benefits, testimonials). Up to 5, sent one by one.')}
            >
              <GalleryUploader value={draft.gallery_urls || []} onChange={(urls) => set('gallery_urls', urls)} max={5} />
            </Field>
          </Section>

          {/* ── Details to collect — services only (migration 0012) ─ */}
          {isService && (
            <Section
              title={t('botFunnel.customFields.sectionLabel')}
              icon={<ListChecks size={18} />}
              subtitle={t('botFunnel.customFields.sectionHint')}
            >
              <CustomFieldsEditor value={draft.custom_fields || []} onChange={(cf) => set('custom_fields', cf)} />
            </Section>
          )}

          {/* ── Availability & routing ───────────────────────────── */}
          <Section
            title={t('botFunnel.drawer.secAvailability', 'Availability & routing')}
            icon={<Radio size={18} />}
            subtitle={t('botFunnel.drawer.secAvailabilitySub', 'When the bot offers it, which numbers reply, and where orders go.')}
          >
            <Field label={t('botFunnel.drawer.status')}>
              <select className="funnel-input" value={draft.status} onChange={(e) => set('status', e.target.value as Product['status'])}>
                <option value="active">
                  {isService ? t('botFunnel.drawer.statusActiveService') : t('botFunnel.drawer.statusActiveProduct')}
                </option>
                {/* Services have no inventory — only products can be out of stock. */}
                {!isService && (
                  <option value="out_of_stock">{t('botFunnel.drawer.statusOutOfStock')}</option>
                )}
                <option value="archived">{t('botFunnel.drawer.statusArchived')}</option>
              </select>
            </Field>
            <Field label={t('botFunnel.drawer.whatsappLabel')} hint={t('botFunnel.drawer.whatsappHint')} required>
              <SessionPicker selected={draft.whatsapp_session_ids || []} onChange={(ids) => set('whatsapp_session_ids', ids)} />
            </Field>
            <Field
              label={`${t('botFunnel.drawer.sheetsLabel', 'Order webhook (Google Sheets)')} · ${optional}`}
              hint={t('botFunnel.drawer.sheetsHint', 'Confirmed orders for this item POST here. Overrides the seller-wide webhook in Settings.')}
            >
              <input
                className="funnel-input"
                value={draft.sheets_webhook_url || ''}
                onChange={(e) => set('sheets_webhook_url', e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec"
              />
              <SheetsUrlHelper value={draft.sheets_webhook_url || ''} />
            </Field>
          </Section>

          {/* ── Facebook / Instagram ad helper (Click-to-WhatsApp) ── */}
          {!isService && (
            <Section
              title={t('botFunnel.drawer.secAd', 'Pub Facebook / Instagram')}
              icon={<Megaphone size={18} />}
              subtitle={t('botFunnel.drawer.secAdSub', 'Le message à coller dans votre pub Click-to-WhatsApp pour que le bot reconnaisse CE produit.')}
            >
              <Field label={t('botFunnel.drawer.adPrefillLabel', 'Message pré-rempli (généré automatiquement depuis le nom)')}>
                <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                  <input
                    className="funnel-input"
                    readOnly
                    value={adPrefill || t('botFunnel.drawer.adPrefillEmpty', '⬆ Saisissez d’abord le nom du produit ci-dessus')}
                    onFocus={(e) => { if (adPrefill) e.currentTarget.select(); }}
                    style={{ flex: 1, color: adPrefill ? undefined : '#9aa0ad' }}
                  />
                  <button
                    type="button"
                    disabled={!adPrefill}
                    onClick={() => {
                      if (!adPrefill) return;
                      void navigator.clipboard?.writeText(adPrefill);
                      setCopiedAd(true);
                      setTimeout(() => setCopiedAd(false), 1800);
                    }}
                    style={{
                      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '.3rem',
                      padding: '.55rem .8rem', borderRadius: '10px', border: '1.5px solid #e6e8f0',
                      background: copiedAd ? '#16a34a' : '#fff', color: copiedAd ? '#fff' : '#6A3DFF',
                      cursor: adPrefill ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: '.82rem',
                    }}
                  >
                    {copiedAd
                      ? <><CheckCircle2 size={14} /> {t('common.copied', 'Copié')}</>
                      : <><Copy size={14} /> {t('common.copy', 'Copier')}</>}
                  </button>
                </div>
              </Field>
              <p style={{ fontSize: '.78rem', color: '#6b7280', lineHeight: 1.55, margin: '.4rem 0 0' }}>
                {t('botFunnel.drawer.adHint',
                   'Collez ce texte dans votre pub Facebook / Instagram → « Message → Message pré-rempli ». Quand un client clique sur la pub, ce message part tout seul, et le bot reconnaît CE produit grâce à son nom. 💡 Astuce : ajoutez des variantes du nom dans les Alias ci-dessus.')}
              </p>
            </Section>
          )}

          {/* ── Price ────────────────────────────────────────────── */}
          <Section
            title={k('botFunnel.drawer.pricingProduct', 'botFunnel.drawer.pricingService', 'Pricing (single-market)', 'Price')}
            icon={<CircleDollarSign size={18} />}
            subtitle={t('botFunnel.drawer.secPriceSub', 'Shown to the customer and used in the order recap.')}
          >
            <div className="funnel-grid-2">
              <Field label={t('botFunnel.drawer.countryLabel', 'Country')}>
                <select
                  className="funnel-input"
                  value={pc?.country_code || ''}
                  onChange={(e) => {
                    const code = e.target.value;
                    const m = PRICING_COUNTRIES.find((c) => c.code === code);
                    // Auto-fill the market's local currency (still overridable below).
                    setCountry(m ? { country_code: code, currency: m.currency } : { country_code: code });
                  }}
                >
                  {(!pc?.country_code || !PRICING_COUNTRIES.some((c) => c.code === pc.country_code)) && (
                    <option value={pc?.country_code || ''}>{pc?.country_code || '—'}</option>
                  )}
                  {PRICING_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                  ))}
                </select>
              </Field>
              <Field label={t('botFunnel.drawer.languageLabel', 'Language')}>
                <select className="funnel-input" value={pc?.language_code || 'fr'} onChange={(e) => setCountry({ language_code: e.target.value })}>
                  <option value="fr">Français</option>
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                  <option value="ary">Darija (Maghribia)</option>
                  <option value="es">Español</option>
                </select>
              </Field>
              <Field label={k('botFunnel.drawer.priceLabelProduct', 'botFunnel.drawer.priceLabelService', 'Unit price', 'Price')}>
                <input type="number" className="funnel-input" value={pc?.price || 0} onChange={(e) => setCountry({ price: parseFloat(e.target.value || '0') })} step="any" min="0" />
              </Field>
              <Field label={t('botFunnel.drawer.currencyLabel', 'Currency')}>
                <select className="funnel-input" value={pc?.currency || ''} onChange={(e) => setCountry({ currency: e.target.value })}>
                  {(!pc?.currency || !PRICING_CURRENCIES.includes(pc.currency)) && (
                    <option value={pc?.currency || ''}>{pc?.currency || '—'}</option>
                  )}
                  {PRICING_CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>

          <div className="funnel-drawer-foot">
            {error && <div className="funnel-error"><AlertCircle size={14} /> {error}</div>}
            <div className="funnel-foot-actions">
              <button type="button" className="funnel-btn ghost" onClick={onClose} disabled={busy}>
                {t('botFunnel.drawer.cancel', 'Cancel')}
              </button>
              <button type="submit" className="funnel-btn primary" disabled={busy}>
                {busy ? <Loader2 className="spin" /> : <Save />} {isNew ? t('botFunnel.drawer.create', 'Create') : t('botFunnel.drawer.save', 'Save')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Orders ───────────────────────────────────────────────────────────────
// Scoped to the section's `kind`: the E-commerce COD section shows only
// orders for physical products; the Services section shows only bookings for
// services. An order whose product has no kind (or no product row) is treated
// as e-commerce, matching the Products listing rule. (Requires the brain's
// /funnel/orders to return products(name,kind) — falls back to e-commerce-only
// until the brain is restarted.)
function OrdersTab({ kind }: { kind: 'product' | 'service' }) {
  const { t } = useTranslation();
  const { config, label } = useServiceConfig();
  const { activeSessionId } = useActiveSession();
  const isService = kind === 'service';
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryFlash, setRetryFlash] = useState<{ id: string; ok: boolean; msg: string } | null>(null);

  async function retrySheet(orderId: string) {
    setRetryingId(orderId);
    setRetryFlash(null);
    try {
      const r = await ffetch(`/funnel/orders/${orderId}/retry-sheet`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setRetryFlash({ id: orderId, ok: true, msg: 'Pushed to sheet!' });
      } else {
        setRetryFlash({ id: orderId, ok: false, msg: j.message || j.error || 'Retry failed' });
      }
      // Refresh so the status pill flips.
      await load();
    } catch {
      setRetryFlash({ id: orderId, ok: false, msg: "Couldn't reach the server" });
    } finally {
      setRetryingId(null);
      // Auto-hide flash after a few seconds.
      setTimeout(() => setRetryFlash(f => (f && f.id === orderId ? null : f)), 4500);
    }
  }

  async function load() {
    setBusy(true);
    try {
      const r = await ffetch('/funnel/orders');
      const j = await r.json();
      setOrders(j.orders || []);
    } finally { setBusy(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  // Strict separation: only this section's kind. Null product / null kind →
  // e-commerce, so legacy orders surface under E-commerce COD, never Services.
  // Then scope to the active WhatsApp number: an order inherits its product's
  // session pins, so it shows under the number(s) that product is pinned to.
  // An order from an unpinned product (empty list) is reachable everywhere,
  // so it stays visible under each number (emptyIsAll). Stats + export below
  // derive from `visible`, so they re-scope automatically with the switcher.
  const visible = useMemo(
    () => (orders || [])
      .filter((o) => ((o.products?.kind as 'product' | 'service') || 'product') === kind)
      .filter((o) => matchesSession(o.products?.whatsapp_session_ids, activeSessionId, true)),
    [orders, kind, activeSessionId],
  );

  const stats = useMemo(() => {
    const c: Record<string, number> = { pending: 0, confirmed: 0, dispatched: 0, delivered: 0, cancelled: 0 };
    visible.forEach((o) => { c[o.status] = (c[o.status] || 0) + 1; });
    return c;
  }, [visible]);

  // Excel export — generate a real .xlsx file from whatever orders are
  // currently loaded (what the table shows) and trigger a download.
  // Why xlsx instead of CSV: customer names are often in Arabic + the
  // addresses are mixed FR/AR. CSV without a BOM corrupts those in
  // Excel; CSV with a BOM still confuses Numbers / older Excel. A real
  // .xlsx is universally readable and preserves cell types (numbers
  // stay numeric so SUM works on the Total column).
  function exportOrdersToExcel() {
    const rows = visible;
    if (rows.length === 0) return;

    // Column order chosen to mirror what the seller sees in the table:
    // when → product → customer → phone → address → qty → total → status.
    // Numbers (Qty, Unit price, Total) stay as numbers so the sheet
    // user can sort / filter / SUM them. Phone is forced to string with
    // a leading apostrophe-equivalent so Excel doesn't drop the +.
    const data = rows.map((o) => ({
      'When':              new Date(o.created_at),
      'Product':           o.products?.name || '',
      'Customer':          o.customer_name || '',
      'Phone':             o.customer_phone || '',
      'Address':           o.customer_address || '',
      'City':              o.customer_city || '',
      'Country':           o.country_code || '',
      'Qty':               o.quantity,
      'Unit price':        o.unit_price,
      'Total':             o.total_price,
      'Currency':          o.currency || '',
      'Status':            o.status || '',
      'Sheet sync':        o.sheets_sync_status || '',
      'Order ID':          o.id,
    }));

    const ws = XLSX.utils.json_to_sheet(data, { cellDates: true });

    // Format the When column as a Excel date so SUM/filter-by-date
    // works. json_to_sheet writes them as Date cells already; we just
    // pin a friendly display format.
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let row = 1; row <= range.e.r; row++) {
      const cell = ws[XLSX.utils.encode_cell({ c: 0, r: row })];
      if (cell && cell.t === 'd') cell.z = 'yyyy-mm-dd hh:mm:ss';
    }

    // Width per column — eyeballed but matches typical content lengths.
    // Excel autosizes on load; this just gives a sensible starting point.
    ws['!cols'] = [
      { wch: 19 }, // When
      { wch: 18 }, // Product
      { wch: 20 }, // Customer
      { wch: 15 }, // Phone
      { wch: 40 }, // Address
      { wch: 14 }, // City
      { wch: 8 },  // Country
      { wch: 6 },  // Qty
      { wch: 12 }, // Unit price
      { wch: 12 }, // Total
      { wch: 9 },  // Currency
      { wch: 12 }, // Status
      { wch: 11 }, // Sheet sync
      { wch: 36 }, // Order ID
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');

    // XLSX.writeFile handles the download + filename in browsers.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    XLSX.writeFile(wb, `${isService ? 'bookings' : 'orders'}-${stamp}.xlsx`);
  }

  return (
    <div>
      <div className="funnel-row-between">
        <div className="funnel-stats">
          {Object.entries(stats).map(([k, v]) => (
            <div key={k} className="funnel-stat">
              <p className="funnel-stat-label">
                {label(config.statusLabels[k as keyof typeof config.statusLabels])}
              </p>
              <p className="funnel-stat-value">{v}</p>
            </div>
          ))}
        </div>
        <div className="funnel-actions">
          <button
            className="funnel-btn ghost"
            onClick={exportOrdersToExcel}
            disabled={visible.length === 0}
            type="button"
            title="Download every order in the table below as a single Excel (.xlsx) file."
          >
            <FileDown /> {t('botFunnel.orders.exportExcel', 'Export Excel')}
          </button>
          <button className="funnel-btn ghost" onClick={load} disabled={busy} type="button">
            {busy ? <Loader2 className="spin" /> : <RefreshCw />} {t('common.refresh')}
          </button>
        </div>
      </div>

      {!orders && <p className="funnel-muted">{t('common.loading')}</p>}
      {orders && visible.length === 0 && (
        <div className="funnel-empty">
          {isService ? <CalendarCheck /> : <ShoppingBag />}
          <p>{isService ? t('botFunnel.services.emptyOrders') : label(config.emptyOrders)}</p>
        </div>
      )}
      {orders && visible.length > 0 && (
        <div className="funnel-table-wrap">
          <table className="funnel-table">
            <thead>
              <tr>
                <th>{label(config.ordersColumns.when)}</th>
                <th>{label(config.ordersColumns.product)}</th>
                <th>{label(config.ordersColumns.customer)}</th>
                <th>{label(config.ordersColumns.phone)}</th>
                <th>{label(config.ordersColumns.address)}</th>
                <th>{label(config.ordersColumns.quantity)}</th>
                <th>{label(config.ordersColumns.total)}</th>
                <th>{t('botFunnel.orders.sheetColumn', 'Sheet')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id}>
                  <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="bold">{o.products?.name || '—'}</td>
                  <td>{o.customer_name || '—'}</td>
                  <td className="mono">
                    {o.customer_phone
                      ? <a href={`https://wa.me/${o.customer_phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">{o.customer_phone}</a>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{[o.customer_address, o.customer_city, o.country_code].filter(Boolean).join(', ')}</td>
                  <td className="bold center">{o.quantity}</td>
                  <td className="bold right">{o.total_price} {o.currency}</td>
                  <td>
                    <div className="funnel-sheet-cell">
                      {o.sheets_sync_status === 'synced'
                        ? <span className="pill ok">synced</span>
                        : o.sheets_sync_status === 'failed'
                          ? <span className="pill danger">failed</span>
                          : <span className="pill">pending</span>}
                      {o.sheets_sync_status !== 'synced' && (
                        <button
                          type="button"
                          className="funnel-btn ghost small"
                          onClick={() => retrySheet(o.id)}
                          disabled={retryingId === o.id}
                          title="Re-push this order to your Google Sheet"
                        >
                          {retryingId === o.id
                            ? <Loader2 size={12} className="spin" />
                            : <RefreshCw size={12} />}
                          Retry
                        </button>
                      )}
                      {retryFlash?.id === o.id && (
                        <span className={`funnel-retry-flash ${retryFlash.ok ? 'ok' : 'err'}`}>
                          {retryFlash.msg}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Conversations ────────────────────────────────────────────────────────
function ConversationsTab() {
  const { activeSessionId } = useActiveSession();
  const [convs, setConvs] = useState<ConversationRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await ffetch('/funnel/conversations');
      const j = await r.json();
      setConvs(j.conversations || []);
    } finally { setBusy(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  // Scope to the active WhatsApp number. A conversation inherits the session
  // pins of the product the bot detected (brain resolves `session_jids`).
  // emptyIsAll=false: a brand-new lead with no detected product yet can't be
  // attributed to any number, so it appears only under "All sessions".
  const visible = useMemo(
    () => (convs || []).filter((c) => matchesSession(c.session_jids, activeSessionId, false)),
    [convs, activeSessionId],
  );

  return (
    <div>
      <div className="funnel-row-between">
        <p className="funnel-help">
          Active customer conversations and the order fields the bot has
          already collected. Auto-refreshes every 15s.
        </p>
        <button className="funnel-btn ghost" onClick={load} disabled={busy} type="button">
          {busy ? <Loader2 className="spin" /> : <RefreshCw />} Refresh
        </button>
      </div>

      {!convs && <p className="funnel-muted">Loading…</p>}
      {convs && visible.length === 0 && (
        <div className="funnel-empty">
          <MessagesSquare />
          <p>No active conversations.</p>
        </div>
      )}
      {convs && visible.length > 0 && (
        <div className="funnel-table-wrap">
          <table className="funnel-table">
            <thead>
              <tr>
                <th>Started</th><th>JID</th><th>Phone</th><th>Country</th><th>Lang</th><th>Status</th><th>Collected</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{new Date(c.started_at).toLocaleString()}</td>
                  <td className="mono small">{c.customer_jid}</td>
                  <td className="mono">{c.customer_phone || '—'}</td>
                  <td>{c.country_code || '—'}</td>
                  <td>{c.language_code || '—'}</td>
                  <td><span className={'pill ' + c.status}>{c.status}</span></td>
                  <td className="small mono">{JSON.stringify(c.pending_order_fields || {}).slice(0, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────
function SettingsTab() {
  // The Bot Settings tab now exposes ONLY the high-level Business
  // identity: name, default language, ship-to countries. The four
  // operator-overload sections that used to live here — bot persona,
  // WhatsApp gateway credentials, default Sheets webhook, daily-message
  // cap — were removed per operator request because:
  //   • Bot persona is now driven globally by the Confirmatrice Pro Pro
  //     system prompt in brain.py (a free-text override per seller just
  //     gave LLMs room to drift off-script).
  //   • OpenWA gateway credentials belong on the dedicated Sessions
  //     page — duplicating them here invited the seller to misconfigure
  //     one copy and not the other.
  //   • Default Sheets webhook lived on each product anyway (the
  //     per-product field always overrode this one in practice).
  //   • Daily message cap was never actually enforced — the brain's
  //     rate limit is per-user-per-second, not a daily quota, so the
  //     field was misleading.
  // If any of these come back, restore the <Section> blocks AND the
  // matching keys in the save payload below.
  const { t } = useTranslation();
  const { label } = useServiceConfig();
  const [seller, setSeller] = useState<SellerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await ffetch('/funnel/settings');
      const j = await r.json();
      setSeller(j.seller);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!seller) return;
    setBusy(true); setError(null);
    try {
      const payload: Record<string, unknown> = {
        business_name: seller.business_name,
        default_language: seller.default_language,
        country_codes: seller.country_codes,
        // Vertical + tone. Saving the vertical re-skins the whole dashboard
        // (titles, columns, terminology) and steers the bot's data-collection
        // script — so drop the cached config to force an immediate re-render.
        business_category: seller.business_category || null,
        tone_of_voice: seller.tone_of_voice || null,
      };
      const r = await ffetch('/funnel/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      invalidateServiceConfig();
      setSavedAt(new Date());
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!seller) return <p className="funnel-muted">Loading…</p>;

  function set<K extends keyof SellerSettings>(k: K, v: SellerSettings[K]) {
    setSeller({ ...seller!, [k]: v });
  }

  return (
    <form onSubmit={save} className="funnel-settings">
      <Section title="Business">
        <Field label="Business name">
          <input className="funnel-input" value={seller.business_name} onChange={(e) => set('business_name', e.target.value)} />
        </Field>
        <Field label="Default language">
          <select className="funnel-input" value={seller.default_language} onChange={(e) => set('default_language', e.target.value)}>
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="ar">العربية</option>
            <option value="ary">Darija (Maghribia)</option>
            <option value="es">Español</option>
          </select>
        </Field>
        <Field
          label={t('botFunnel.settings.businessType', 'Business type')}
          hint={t(
            'botFunnel.settings.businessTypeHint',
            'Tailors the whole dashboard (titles, columns, wording) and how the bot collects info from customers.',
          )}
        >
          <select
            className="funnel-input"
            value={seller.business_category || 'e_commerce'}
            onChange={(e) => set('business_category', e.target.value)}
          >
            {BUSINESS_CATEGORY_OPTIONS.map((opt) => {
              const cfg = getServiceConfig(opt.serviceType);
              return (
                <option key={opt.value} value={opt.value}>
                  {cfg.icon} {label(cfg.displayName)}
                </option>
              );
            })}
          </select>
        </Field>
        <Field
          label={t('botFunnel.settings.tone', 'Tone of voice')}
          hint={t('botFunnel.settings.toneHint', 'How the bot sounds when it chats with customers.')}
        >
          <select
            className="funnel-input"
            value={seller.tone_of_voice || 'friendly'}
            onChange={(e) => set('tone_of_voice', e.target.value)}
          >
            <option value="friendly">{t('botFunnel.settings.toneFriendly', 'Friendly')}</option>
            <option value="professional">{t('botFunnel.settings.toneProfessional', 'Professional')}</option>
            <option value="persuasive">{t('botFunnel.settings.tonePersuasive', 'Persuasive')}</option>
          </select>
        </Field>
        <Field label="Countries you ship to" hint="ISO 3166-1 alpha-2, comma-separated (GN, MA, FR…)">
          <input
            className="funnel-input"
            value={(seller.country_codes || []).join(', ')}
            onChange={(e) => set('country_codes', e.target.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))}
            placeholder="GN, MA"
          />
        </Field>
      </Section>

      {error && <div className="funnel-error">✗ {error}</div>}
      <div className="funnel-row-between">
        <button type="submit" className="funnel-btn primary" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : <Save />} Save settings
        </button>
        {savedAt && <span className="funnel-success">Saved at {savedAt.toLocaleTimeString()}</span>}
      </div>
    </form>
  );
}

// ── Small layout helpers ─────────────────────────────────────────────────
function Section({ title, icon, subtitle, children }: {
  title: string;
  icon?: React.ReactNode;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="funnel-section">
      <div className="funnel-section-head">
        {icon && <span className="funnel-section-icon" aria-hidden="true">{icon}</span>}
        <div className="funnel-section-headings">
          <h2>{title}</h2>
          {subtitle && <p className="funnel-section-sub">{subtitle}</p>}
        </div>
      </div>
      <div className="funnel-section-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="funnel-field">
      <span className="funnel-field-label">
        {label}
        {required && <span className="funnel-field-req" aria-hidden="true"> *</span>}
      </span>
      {children}
      {hint && <span className="funnel-field-hint">{hint}</span>}
    </label>
  );
}

// ── CustomFieldsEditor ───────────────────────────────────────────────────
// The seller-defined extraction schema for a service (migration 0012).
// Two parts:
//   1. Standard toggles — Nom / Téléphone. Toggling adds/removes a built-in
//      field. Phone is recorded as a field but the bot NEVER asks for it
//      (it reads the number from the WhatsApp JID), hence the note.
//   2. Custom rows — each is a free label + a type + a required flag, plus a
//      remove button. "+ Add field" appends a blank editable row.
// The whole array is emitted as `value`; the brain re-sanitises on save
// (slugifies keys, dedups), so we only need to keep the local model sane.
// An EMPTY array means "no schema" → the brain keeps its hard-coded service
// flow, so a seller who never opens this loses nothing.
function CustomFieldsEditor({ value, onChange }: {
  value: CustomField[];
  onChange: (fields: CustomField[]) => void;
}) {
  const { t } = useTranslation();

  const hasName  = value.some(f => f.is_standard && f.key === 'name');
  const hasPhone = value.some(f => f.is_standard && f.key === 'phone');
  const customs  = value.filter(f => !f.is_standard);

  // Single emit path: standards (name, then phone) always lead, custom rows
  // follow in their existing order. Keeps the array canonical on every edit.
  function emit(nextName: boolean, nextPhone: boolean, nextCustoms: CustomField[]) {
    const out: CustomField[] = [];
    if (nextName)  out.push({ key: 'name',  label: t('botFunnel.customFields.standard.name'),  type: 'text',  required: true, is_standard: true });
    if (nextPhone) out.push({ key: 'phone', label: t('botFunnel.customFields.standard.phone'), type: 'phone', required: true, is_standard: true });
    onChange([...out, ...nextCustoms]);
  }

  function patchCustom(i: number, patch: Partial<CustomField>) {
    emit(hasName, hasPhone, customs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  // Custom-field types the seller can pick. 'phone' is intentionally absent —
  // it only exists as the standard toggle (the bot auto-captures the number).
  const CUSTOM_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'choice'];

  return (
    <div className="funnel-cf">
      {/* Standard toggles */}
      <div className="funnel-cf-standard">
        <span className="funnel-cf-standard-title">{t('botFunnel.customFields.standardTitle')}</span>
        <div className="funnel-chip-group">
          <button
            type="button"
            className={`funnel-chip ${hasName ? 'is-on' : ''}`}
            onClick={() => emit(!hasName, hasPhone, customs)}
          >
            {hasName ? <CheckCircle2 size={13} /> : <span className="funnel-chip-dot" />}
            <span className="funnel-chip-name">{t('botFunnel.customFields.standard.name')}</span>
          </button>
          <button
            type="button"
            className={`funnel-chip ${hasPhone ? 'is-on' : ''}`}
            onClick={() => emit(hasName, !hasPhone, customs)}
          >
            {hasPhone ? <CheckCircle2 size={13} /> : <span className="funnel-chip-dot" />}
            <span className="funnel-chip-name">{t('botFunnel.customFields.standard.phone')}</span>
          </button>
        </div>
        {hasPhone && <span className="funnel-cf-note">{t('botFunnel.customFields.phoneNote')}</span>}
      </div>

      {/* Custom field rows */}
      {customs.length > 0 && (
        <div className="funnel-cf-list">
          {customs.map((f, i) => (
            <div key={i} className="funnel-cf-row">
              <input
                className="funnel-input funnel-cf-label"
                value={f.label}
                placeholder={t('botFunnel.customFields.addPlaceholder')}
                onChange={(e) => patchCustom(i, { label: e.target.value, key: slugifyFieldKey(e.target.value) })}
              />
              <select
                className="funnel-input funnel-cf-type"
                value={f.type}
                onChange={(e) => patchCustom(i, { type: e.target.value as CustomFieldType })}
              >
                {CUSTOM_TYPES.map(tp => (
                  <option key={tp} value={tp}>{t(`botFunnel.customFields.type.${tp}`)}</option>
                ))}
              </select>
              <label className="funnel-cf-required">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => patchCustom(i, { required: e.target.checked })}
                />
                <span>{t('botFunnel.customFields.required')}</span>
              </label>
              <button
                type="button"
                className="funnel-btn icon danger small"
                onClick={() => emit(hasName, hasPhone, customs.filter((_, idx) => idx !== i))}
                title={t('botFunnel.customFields.remove')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!hasName && !hasPhone && customs.length === 0 && (
        <div className="funnel-cf-empty">{t('botFunnel.customFields.empty')}</div>
      )}

      <button
        type="button"
        className="funnel-btn secondary small funnel-cf-add"
        onClick={() => emit(hasName, hasPhone, [...customs, { key: '', label: '', type: 'text', required: true, is_standard: false }])}
      >
        <Plus size={14} /> {t('botFunnel.customFields.add')}
      </button>
    </div>
  );
}

// ── SheetsUrlHelper ──────────────────────────────────────────────────────
// Most first-time sellers paste the SPREADSHEET URL
// (https://docs.google.com/spreadsheets/d/…/edit) by mistake. That URL
// can't receive POSTs — orders fail silently. This helper detects the
// wrong shape and walks them through deploying an Apps Script Web App,
// with a one-click copy of the script body.
const APPS_SCRIPT_BODY = `// Closwiz → Google Sheets — paste this in Apps Script, deploy as Web App.
// 1. Open your Sheet → Extensions → Apps Script.
// 2. Replace anything in Code.gs with this entire file.
// 3. Click Deploy → New deployment → Type: Web app.
// 4. Execute as: Me · Who has access: Anyone · Deploy.
// 5. Copy the /exec URL and paste it back in Closwiz.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    // Header row if the sheet is empty.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['sku','Customer_Name','Phone','address','Quantity','total_price']);
    }
    sheet.appendRow([
      body.sku           || '',
      body.Customer_Name || '',
      body.Phone         || '',
      body.address       || '',
      body.Quantity      || '',
      body.total_price   || '',
    ]);
    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false, error: String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

function SheetsUrlHelper({ value }: { value: string }) {
  const trimmed = (value || '').trim();
  const looksLikeSheetView = /docs\.google\.com\/spreadsheets\//i.test(trimmed);
  const looksLikeAppsScript = /script\.google(?:usercontent)?\.com\/(?:a\/[^/]+\/)?macros\/s\/[^/]+\/exec/i.test(trimmed);
  const isWrong = trimmed && !looksLikeAppsScript;

  const [showHelp, setShowHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!trimmed) {
    // Empty — show a friendly "where do I get this URL?" toggle.
    return (
      <div className="funnel-sheets-help">
        <button type="button" className="funnel-linklike" onClick={() => setShowHelp(v => !v)}>
          {showHelp ? '▾' : '▸'} Where do I get this URL?
        </button>
        {showHelp && <SheetsHelpBody copied={copied} setCopied={setCopied} />}
      </div>
    );
  }

  if (isWrong) {
    return (
      <div className="funnel-sheets-warn">
        <div className="funnel-sheets-warn-head">
          <AlertCircle size={16} />
          <strong>
            {looksLikeSheetView
              ? "That's the spreadsheet URL, not the webhook URL."
              : "That doesn't look like an Apps Script Web App URL."}
          </strong>
        </div>
        <p>
          Orders can't be POSTed to a spreadsheet directly. You need to
          deploy a tiny Apps Script first — Closwiz calls that, and the
          script writes a new row in your sheet.
        </p>
        <button type="button" className="funnel-linklike" onClick={() => setShowHelp(v => !v)}>
          {showHelp ? '▾ Hide the steps' : '▸ Show me the steps (1 minute)'}
        </button>
        {showHelp && <SheetsHelpBody copied={copied} setCopied={setCopied} />}
      </div>
    );
  }

  return (
    <div className="funnel-sheets-ok">
      <CheckCircle2 size={14} /> Looks like a valid Apps Script Web App URL.
    </div>
  );
}

function SheetsHelpBody({ copied, setCopied }: { copied: boolean; setCopied: (v: boolean) => void }) {
  async function copyScript() {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT_BODY);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* ignore */ }
  }
  return (
    <div className="funnel-sheets-steps">
      <ol>
        <li>Open your Google Sheet.</li>
        <li>Click <strong>Extensions → Apps Script</strong>.</li>
        <li>Delete anything in <code>Code.gs</code> and paste the script below.</li>
        <li>Click <strong>Deploy → New deployment</strong>. Choose <strong>Type: Web app</strong>.</li>
        <li>Set <strong>Execute as: Me</strong> and <strong>Who has access: Anyone</strong>. Click <strong>Deploy</strong>.</li>
        <li>Copy the URL that ends in <code>/exec</code> and paste it above.</li>
      </ol>
      <div className="funnel-sheets-code">
        <button type="button" className="funnel-btn ghost small funnel-sheets-copy" onClick={copyScript}>
          {copied ? <><CheckCircle2 size={13} /> Copied!</> : <>Copy script</>}
        </button>
        <pre>{APPS_SCRIPT_BODY}</pre>
      </div>
    </div>
  );
}

// ── SessionPicker ────────────────────────────────────────────────────────
// Multiselect rendered as toggleable chips. Loads the seller's paired
// WhatsApp sessions from brain's /funnel/wa-sessions on mount, then lets
// the seller tick the ones this product is the default for. Selected
// session UUIDs are saved on products.whatsapp_session_ids (migration 0006).
function SessionPicker({
  selected, onChange,
}: { selected: string[]; onChange: (ids: string[]) => void }) {
  const [sessions, setSessions] = useState<WaSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abort = false;
    async function load() {
      try {
        const r = await ffetch('/funnel/wa-sessions');
        const j = await r.json().catch(() => ({}));
        if (abort) return;
        if (!r.ok) { setError(j.error || 'Could not load WhatsApp sessions'); return; }
        setError(null);
        setSessions(j.sessions || []);
      } catch {
        if (!abort) setError("Couldn't reach the server");
      }
    }
    load();
    // Re-poll while the drawer is open so a number the seller links in the
    // Sessions page (another tab) shows up here within a few seconds — the
    // brain auto-registers it on each call, no manual refresh needed.
    const t = setInterval(load, 10_000);
    return () => { abort = true; clearInterval(t); };
  }, []);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter(x => x !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  if (error) {
    return <div className="funnel-uploader-err"><AlertCircle size={14} /> {error}</div>;
  }
  if (sessions === null) {
    return <div className="funnel-muted">Loading paired numbers…</div>;
  }
  if (sessions.length === 0) {
    return (
      <div className="funnel-muted">
        No paired WhatsApp number for this seller yet. Pair one in the
        Sessions page, then come back to assign products to it.
      </div>
    );
  }
  return (
    <div className="funnel-chip-group">
      {sessions.map(s => {
        const on = selected.includes(s.id);
        const label = s.name || s.id.slice(0, 8);
        const phone = s.phone ? `+${s.phone.replace(/^\+/, '')}` : '';
        return (
          <button
            key={s.id}
            type="button"
            className={`funnel-chip ${on ? 'is-on' : ''}`}
            onClick={() => toggle(s.id)}
            title={s.id}
          >
            {on ? <CheckCircle2 size={13} /> : <span className="funnel-chip-dot" />}
            <span className="funnel-chip-name">{label}</span>
            {phone && <span className="funnel-chip-phone">{phone}</span>}
          </button>
        );
      })}
    </div>
  );
}


// ── GalleryUploader ─────────────────────────────────────────────────────
// Multi-image picker for the product's supplementary gallery. Same upload
// path as ImageUploader (POST /funnel/upload/product-image → Supabase
// Storage public URL), but holds an ordered list of URLs and renders
// thumbnails with a tiny X to delete. Bot reads products.gallery_urls
// and sends those images one-by-one when a customer first asks about
// the product.
function GalleryUploader({
  value, onChange, max = 5,
}: { value: string[]; onChange: (urls: string[]) => void; max?: number }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const busyRef = useRef(false);
  const remainingSlots = Math.max(0, max - value.length);

  async function uploadOne(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/funnel/upload/product-image');
      const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
      if (sellerId) xhr.setRequestHeader('X-Seller-Id', sellerId);
      xhr.onload = () => {
        let j: { url?: string; error?: string } = {};
        try { j = JSON.parse(xhr.responseText); } catch { /* keep empty */ }
        if (xhr.status >= 200 && xhr.status < 300 && j.url) resolve(j.url);
        else reject(new Error(j.error || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    });
  }

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    const filtered = Array.from(files).filter(f =>
      f.type.startsWith('image/') && f.size <= 5 * 1024 * 1024,
    ).slice(0, remainingSlots);
    if (filtered.length === 0) {
      if (remainingSlots === 0) setError(`Maximum ${max} images per product.`);
      else setError('Only PNG/JPG/WEBP/GIF under 5 MB are accepted.');
      return;
    }
    if (busyRef.current) return;       // ignore a 2nd concurrent trigger (drop + click race)
    busyRef.current = true;
    setUploading(true);
    setProgress({ done: 0, total: filtered.length });
    const uploaded: string[] = [];
    for (const f of filtered) {
      try {
        const url = await uploadOne(f);
        uploaded.push(url);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    if (uploaded.length) onChange([...value, ...uploaded]);
    setUploading(false);
    busyRef.current = false;
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) void handleFiles(e.target.files);
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  }

  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  return (
    <div className="funnel-gallery">
      <div className="funnel-gallery-grid">
        {value.map((url, i) => (
          <div key={url + i} className="funnel-gallery-thumb">
            <img src={url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0.2')} />
            <button
              type="button"
              className="funnel-gallery-remove"
              onClick={() => removeAt(i)}
              title="Remove from gallery"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {remainingSlots > 0 && (
          <div
            className={`funnel-gallery-add ${dragOver ? 'is-drag' : ''}`}
            onClick={() => !uploading && inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
          >
            {uploading ? (
              <>
                <Loader2 size={18} className="spin" />
                <span>{progress.done}/{progress.total}</span>
              </>
            ) : (
              <>
                <Upload size={18} />
                <span>{value.length ? 'Add more' : 'Drop images'}</span>
                <span className="funnel-gallery-slots">{remainingSlots} slot{remainingSlots > 1 ? 's' : ''} left</span>
              </>
            )}
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={onPick}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'none' }}
        />
      </div>
      {error && (
        <div className="funnel-uploader-err">
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </div>
  );
}


// ── ImageUploader ────────────────────────────────────────────────────────
// Drag-drop OR click-to-pick uploader. Sends the file to brain's
// /funnel/upload/product-image endpoint (multipart), which forwards it to
// Supabase Storage. The brain returns the public URL; we hand that to
// the parent via onChange so it gets saved on the product row.
function ImageUploader({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const busyRef = useRef(false);

  async function upload(file: File) {
    if (busyRef.current) return;       // ignore a 2nd concurrent trigger (drop + click race)
    busyRef.current = true;
    setError(null);
    setUploading(true);
    setProgress(0);
    try {
      // XHR (not fetch) so we get upload progress events for the UI.
      const url = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/funnel/upload/product-image');
        const sellerId = sessionStorage.getItem('leadecombot_seller_id') || '';
        if (sellerId) xhr.setRequestHeader('X-Seller-Id', sellerId);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let j: { url?: string; error?: string } = {};
          try { j = JSON.parse(xhr.responseText); } catch { /* keep empty */ }
          if (xhr.status >= 200 && xhr.status < 300 && j.url) resolve(j.url);
          else reject(new Error(j.error || `Upload failed (HTTP ${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        const form = new FormData();
        form.append('file', file);
        xhr.send(form);
      });
      onChange(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      setProgress(0);
      busyRef.current = false;
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void upload(f);
    // Reset so re-picking the same file still fires onChange.
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  }

  return (
    <div className="funnel-uploader">
      <div
        className={`funnel-drop ${dragOver ? 'is-drag' : ''} ${value ? 'has-image' : ''}`}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
      >
        {value && !uploading ? (
          <>
            <img src={value} alt="Product" />
            <div className="funnel-drop-overlay">
              <Upload size={16} /> Click or drop to replace
            </div>
          </>
        ) : uploading ? (
          <div className="funnel-drop-busy">
            <Loader2 className="spin" size={28} />
            <span>Uploading… {progress}%</span>
            <div className="funnel-drop-bar"><div style={{ width: `${progress}%` }} /></div>
          </div>
        ) : (
          <div className="funnel-drop-empty">
            <Upload size={26} />
            <strong>Drop an image here</strong>
            <span>or click to browse · PNG / JPG / WEBP / GIF · 5 MB max</span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPick}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'none' }}
        />
      </div>

      {error && (
        <div className="funnel-uploader-err">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {value && (
        <div className="funnel-uploader-actions">
          <input
            className="funnel-input mono small"
            readOnly
            value={value}
            onFocus={(e) => e.target.select()}
            title="Public URL — click to select and copy"
          />
          <button type="button" className="funnel-btn ghost small" onClick={() => onChange('')}>
            <Trash2 size={14} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}
