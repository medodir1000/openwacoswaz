import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Loader2, Save, Upload, X, ImageIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import {
  COUNTRIES, CURRENCIES,
  findCountryByCode, findCurrencyByCode, resolveCountry,
} from '../lib/iso';

const STORAGE_BUCKET = 'product-images';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB (matches bucket file_size_limit)
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

type PC = {
  id?: string;
  country_code: string;
  language_code: string;
  price: number;
  currency: string;
  // Map of quantity → total_price for bulk deals (e.g. {"2": 450000}
  // means 2 units total 450k, overriding 2 × unit price). Edited via the
  // expandable "Bulk offers" panel under each row.
  price_tiers: Record<string, number>;
  translated_name: string | null;
  translated_description: string | null;
  available: boolean;
  _isNew?: boolean;
  _toDelete?: boolean;
  _showTiers?: boolean;   // UI-only: whether the tier editor is expanded
};

type Product = {
  id?: string;
  name: string;
  description: string | null;
  image_url: string | null;
  aliases: string[];
  status: 'active' | 'out_of_stock' | 'archived';
  sheets_webhook_url: string | null;
};

// Reply languages the bot supports out of the box. Add codes here as
// you wire more LLM prompts. CURRENCIES + COUNTRIES come from `lib/iso.ts`.
const LANGUAGES = [
  { code: 'en',  label: 'English' },
  { code: 'fr',  label: 'Français' },
  { code: 'ar',  label: 'العربية' },
  { code: 'ary', label: 'Darija (Maghribia)' },
  { code: 'es',  label: 'Español' },
  { code: 'pt',  label: 'Português' },
  { code: 'de',  label: 'Deutsch' },
];

export default function AdminProductEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new' || !id;
  const nav = useNavigate();
  const { profile } = useAuth();

  const [product, setProduct] = useState<Product>({
    name: '', description: '', image_url: '', aliases: [], status: 'active',
    sheets_webhook_url: '',
  });
  const [countries, setCountries] = useState<PC[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(file: File) {
    setUploadError(null);
    if (!profile?.seller_id) {
      // Admin (no seller_id) uses a special "_admin" folder per the storage RLS.
      // For sellers, we use their seller_id as the first path segment.
    }
    if (!ALLOWED_MIME.includes(file.type)) {
      setUploadError(`File type not allowed (${file.type}). Use JPEG, PNG, WebP, or GIF.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(`File too big (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`);
      return;
    }

    setUploading(true);
    try {
      // Path: <seller_id>/<unix_ms>-<random>-<safe_filename>.<ext>
      // First path segment must match seller_id per the storage RLS policy.
      const folder = profile?.seller_id || '_admin';
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 8);
      const safeBase = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 60);
      const rand = Math.random().toString(36).slice(2, 8);
      const path = `${folder}/${Date.now()}-${rand}-${safeBase}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      setP('image_url', pub.publicUrl);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  useEffect(() => {
    if (isNew) return;
    (async () => {
      const [{ data: p, error: pErr }, { data: pcs, error: pcErr }] = await Promise.all([
        supabase.from('products').select('*').eq('id', id).maybeSingle(),
        supabase.from('product_countries').select('*').eq('product_id', id),
      ]);
      if (pErr || pcErr) { setError((pErr || pcErr)?.message || 'load failed'); return; }
      if (p) setProduct({
        ...p,
        aliases: p.aliases || [],
        sheets_webhook_url: p.sheets_webhook_url ?? '',
      });
      if (pcs) {
        // Normalize price_tiers to a plain object so the editor doesn't
        // crash if the column doesn't exist yet (migration 0003 unapplied).
        setCountries((pcs as PC[]).map(r => ({
          ...r,
          price_tiers: (r.price_tiers && typeof r.price_tiers === 'object') ? r.price_tiers : {},
        })));
      }
    })();
  }, [id, isNew]);

  function setP<K extends keyof Product>(k: K, v: Product[K]) {
    setProduct({ ...product, [k]: v });
  }

  function addCountryRow() {
    setCountries([...countries, {
      country_code: '', language_code: 'en', price: 0, currency: 'USD',
      price_tiers: {},
      translated_name: null, translated_description: null, available: true, _isNew: true,
    }]);
  }
  function updateRow(i: number, patch: Partial<PC>) {
    setCountries(countries.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function markRowDelete(i: number) {
    setCountries(countries.map((r, idx) => idx === i ? { ...r, _toDelete: true } : r));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!profile?.seller_id) { setError('No seller_id on profile'); return; }
    if (!product.name.trim()) { setError('Name required'); return; }
    setBusy(true);
    setError(null);

    try {
      // 1. Upsert the product.
      let productId = product.id;
      if (isNew) {
        const { data, error } = await supabase
          .from('products')
          .insert({
            seller_id: profile.seller_id,
            name: product.name,
            description: product.description,
            image_url: product.image_url,
            aliases: product.aliases,
            status: product.status,
            sheets_webhook_url: product.sheets_webhook_url || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        productId = data.id;
      } else {
        const { error } = await supabase
          .from('products')
          .update({
            name: product.name,
            description: product.description,
            image_url: product.image_url,
            aliases: product.aliases,
            status: product.status,
            sheets_webhook_url: product.sheets_webhook_url || null,
          })
          .eq('id', productId!);
        if (error) throw error;
      }

      // 2. Sync product_countries rows.
      for (const row of countries) {
        if (row._toDelete) {
          if (row.id) await supabase.from('product_countries').delete().eq('id', row.id);
          continue;
        }
        if (!row.country_code) continue;
        const payload: Record<string, unknown> = {
          product_id: productId!,
          country_code: row.country_code.toUpperCase(),
          language_code: row.language_code,
          price: row.price,
          currency: row.currency,
          // Persist the cleaned tier map (drop empty/non-numeric entries).
          price_tiers: Object.fromEntries(
            Object.entries(row.price_tiers || {})
              .filter(([k, v]) => Number.isFinite(Number(k)) && Number(k) > 0 && Number.isFinite(Number(v)) && Number(v) > 0)
              .map(([k, v]) => [String(parseInt(k, 10)), Number(v)])
          ),
          translated_name: row.translated_name,
          translated_description: row.translated_description,
          available: row.available,
        };
        let saveErr: { message: string } | null = null;
        if (row.id && !row._isNew) {
          const { error } = await supabase.from('product_countries').update(payload).eq('id', row.id);
          saveErr = error;
        } else {
          const { error } = await supabase.from('product_countries').upsert(payload, { onConflict: 'product_id,country_code' });
          saveErr = error;
        }
        // If migration 0003 isn't applied yet, the price_tiers column
        // doesn't exist — retry without it so the rest of the row still
        // saves.
        if (saveErr && /price_tiers/.test(saveErr.message || '')) {
          delete payload.price_tiers;
          if (row.id && !row._isNew) {
            await supabase.from('product_countries').update(payload).eq('id', row.id);
          } else {
            await supabase.from('product_countries').upsert(payload, { onConflict: 'product_id,country_code' });
          }
        }
      }

      nav('/admin/products');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visibleRows = countries.filter(r => !r._toDelete);

  return (
    <div className="p-10 max-w-4xl space-y-6">
      <Link to="/admin/products" className="inline-flex items-center gap-1 text-xs font-bold text-zinc-600 hover:text-electric-blue uppercase tracking-wider">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to products
      </Link>

      <div>
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">{isNew ? 'New product' : 'Edit product'}</p>
        <h1 className="text-4xl font-black tracking-tighter mt-1">{product.name || 'Untitled'}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Product basics */}
        <section className="glass-card rounded-2xl p-6 space-y-4">
          <h2 className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Basics</h2>

          <Field label="Name">
            <input value={product.name} onChange={(e) => setP('name', e.target.value)} className="form-input" required />
          </Field>
          <Field label="Description" hint="Short — 1-2 sentences. Bot uses this as background context.">
            <textarea rows={3} value={product.description || ''} onChange={(e) => setP('description', e.target.value)} className="form-input leading-relaxed" />
          </Field>
          <Field
            label="Product image"
            hint="Upload from your computer, or paste a URL below. Stored privately in Supabase Storage with a public-read URL. Max 5 MB."
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect(f);
              }}
            />

            {/* Preview + actions */}
            {product.image_url ? (
              <div className="flex items-center gap-4 mb-3">
                <img
                  src={product.image_url}
                  alt="Product preview"
                  className="w-24 h-24 object-cover rounded-xl border border-zinc-200 bg-zinc-50"
                  onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                />
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-3 py-1.5 rounded-lg text-xs disabled:opacity-50"
                  >
                    {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    {uploading ? 'Uploading…' : 'Replace'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setP('image_url', '')}
                    className="inline-flex items-center gap-1.5 text-zinc-600 hover:text-red-600 text-xs font-bold"
                  >
                    <X className="w-3.5 h-3.5" /> Clear
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full mb-3 border-2 border-dashed border-zinc-300 hover:border-electric-blue hover:bg-electric-blue/5 rounded-xl py-8 px-4 transition-colors text-zinc-500 hover:text-electric-blue disabled:opacity-50"
              >
                <div className="flex flex-col items-center gap-2">
                  {uploading
                    ? <Loader2 className="w-7 h-7 animate-spin" />
                    : <ImageIcon className="w-7 h-7" />}
                  <span className="text-sm font-bold">
                    {uploading ? 'Uploading…' : 'Click to upload product image'}
                  </span>
                  <span className="text-[11px] text-zinc-500">JPEG · PNG · WebP · GIF — up to 5 MB</span>
                </div>
              </button>
            )}

            {uploadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 mb-2">
                ✗ {uploadError}
              </div>
            )}

            {/* Manual URL paste fallback */}
            <input
              value={product.image_url || ''}
              onChange={(e) => setP('image_url', e.target.value)}
              className="form-input !text-xs !py-1.5"
              placeholder="…or paste an image URL"
            />
          </Field>
          <Field label="Aliases" hint="Comma-separated words/phrases the LLM uses to detect this product from the customer's first message. Add synonyms, misspellings, slang.">
            <input
              value={(product.aliases || []).join(', ')}
              onChange={(e) => setP('aliases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              className="form-input"
              placeholder="atay, thé, tea, marrakech mint"
            />
          </Field>
          <Field label="Status">
            <select value={product.status} onChange={(e) => setP('status', e.target.value as Product['status'])} className="form-input">
              <option value="active">Active — bot can sell it</option>
              <option value="out_of_stock">Out of stock — bot acknowledges but can't close</option>
              <option value="archived">Archived — hidden from bot entirely</option>
            </select>
          </Field>
          <Field
            label="Google Sheets webhook URL (per-product)"
            hint="Confirmed orders for this product POST here as JSON. Overrides the seller-wide webhook in Settings. Leave blank to use the seller-wide one. Format: https://script.google.com/macros/s/AKfycb…/exec"
          >
            <input
              value={product.sheets_webhook_url || ''}
              onChange={(e) => setP('sheets_webhook_url', e.target.value)}
              className="form-input"
              placeholder="https://script.google.com/macros/s/.../exec"
            />
          </Field>
        </section>

        {/* Per-country pricing + language */}
        <section className="glass-card rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Per-country pricing</h2>
            <button type="button" onClick={addCountryRow} className="inline-flex items-center gap-1.5 text-xs font-bold text-electric-blue hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add country
            </button>
          </div>

          {visibleRows.length === 0 && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No country rows yet. Add at least one — the bot needs to know the price + language for each market.
            </p>
          )}

          <div className="space-y-3">
            {countries.map((row, i) => row._toDelete ? null : (
              <div key={row.id || `new-${i}`} className="bg-zinc-50 rounded-xl p-3 space-y-3">
              <div className="grid grid-cols-12 gap-2 items-start">
                {/* Country — searchable, accepts full name OR 2-letter code */}
                <div className="col-span-12 sm:col-span-4">
                  <label className="block text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Country</label>
                  <input
                    list={`country-list-${i}`}
                    value={findCountryByCode(row.country_code)?.name || row.country_code || ''}
                    onChange={(e) => {
                      const typed = e.target.value;
                      const resolved = resolveCountry(typed);
                      if (resolved) {
                        // Match found — store ISO code + auto-fill empty currency/lang.
                        const updates: Partial<PC> = { country_code: resolved.code };
                        if (!row.currency && resolved.default_currency) updates.currency = resolved.default_currency;
                        if (!row.language_code && resolved.default_language) {
                          // Only set if it's one of our supported LANGUAGES options.
                          const supported = LANGUAGES.find(l => l.code === resolved.default_language);
                          if (supported) updates.language_code = supported.code;
                        }
                        updateRow(i, updates);
                      } else {
                        // No match yet — keep the raw text in country_code so the input
                        // stays in sync with what the user is typing.
                        updateRow(i, { country_code: typed });
                      }
                    }}
                    className="form-input !py-1.5 !px-2 text-sm"
                    placeholder="Type Morocco, FR, Saudi…"
                  />
                  <datalist id={`country-list-${i}`}>
                    {COUNTRIES.map(c => (
                      <option key={c.code} value={c.name}>{c.flag} {c.code}</option>
                    ))}
                  </datalist>
                </div>

                {/* Language (still a select — only 6 supported MVP options) */}
                <div className="col-span-4 sm:col-span-1">
                  <label className="block text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Lang</label>
                  <select value={row.language_code} onChange={(e) => updateRow(i, { language_code: e.target.value })} className="form-input !py-1.5 !px-2 text-sm">
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                  </select>
                </div>

                <div className="col-span-4 sm:col-span-2">
                  <label className="block text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Price</label>
                  <input type="number" step="0.01" min="0" value={row.price} onChange={(e) => updateRow(i, { price: parseFloat(e.target.value || '0') })} className="form-input !py-1.5 !px-2 text-sm" />
                </div>

                {/* Currency — free-text input. Datalist below provides
                    autocomplete hints for common ones, but the seller can
                    type ANY currency code (or local name). */}
                <div className="col-span-4 sm:col-span-3">
                  <label className="block text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Currency</label>
                  <input
                    list={`currency-list-${i}`}
                    value={row.currency}
                    onChange={(e) => updateRow(i, { currency: e.target.value.toUpperCase() })}
                    className="form-input !py-1.5 !px-2 text-sm uppercase tracking-wider"
                    placeholder="MAD, USD, GNF…"
                    autoComplete="off"
                  />
                  <datalist id={`currency-list-${i}`}>
                    {CURRENCIES.map(c => (
                      <option key={c.code} value={c.code}>{c.symbol} {c.name}</option>
                    ))}
                  </datalist>
                </div>

                <div className="col-span-11 sm:col-span-1">
                  <label className="block text-[10px] uppercase tracking-wider font-bold text-zinc-500 mb-1">Translated name</label>
                  <input
                    value={row.translated_name || ''}
                    onChange={(e) => updateRow(i, { translated_name: e.target.value || null })}
                    className="form-input !py-1.5 !px-2 text-sm"
                    placeholder="optional"
                    title="If set, the bot uses this name instead of the English one when replying to customers in this country."
                  />
                </div>

                <div className="col-span-1 flex items-end justify-end h-full pb-1">
                  <button type="button" onClick={() => markRowDelete(i)} className="text-red-500 hover:text-red-700">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Bulk-pricing tier editor.
                  Off by default — only sellers running bundle promos need it.
                  When expanded, each row is (quantity, total_price) and the
                  brain quotes the total directly instead of multiplying. */}
              <div className="border-t border-zinc-200 pt-3">
                <button
                  type="button"
                  onClick={() => updateRow(i, { _showTiers: !row._showTiers })}
                  className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 hover:text-electric-blue inline-flex items-center gap-1.5"
                >
                  {row._showTiers ? '▾' : '▸'} Bulk offers
                  {Object.keys(row.price_tiers || {}).length > 0 && (
                    <span className="bg-electric-blue/10 text-electric-blue rounded-full px-2 py-0.5">
                      {Object.keys(row.price_tiers || {}).length} tier{Object.keys(row.price_tiers || {}).length === 1 ? '' : 's'}
                    </span>
                  )}
                </button>

                {row._showTiers && (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] text-zinc-500">
                      Override the total for specific quantities. e.g. "2 → 450 000" means 2 units cost 450 000 total (not 2 × unit price). Quantities not listed fall back to <strong>qty × unit price</strong>.
                    </p>
                    {Object.entries(row.price_tiers || {})
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([qty, total]) => (
                        <div key={qty} className="flex items-center gap-2">
                          <input
                            type="number" min="1" step="1"
                            value={qty}
                            onChange={(e) => {
                              const newQty = e.target.value;
                              if (!newQty || newQty === qty) return;
                              const tiers = { ...(row.price_tiers || {}) };
                              delete tiers[qty];
                              tiers[newQty] = Number(total);
                              updateRow(i, { price_tiers: tiers });
                            }}
                            className="form-input !py-1 !px-2 text-sm w-20"
                            title="Quantity"
                          />
                          <span className="text-xs text-zinc-500">units →</span>
                          <input
                            type="number" min="0" step="0.01"
                            value={total}
                            onChange={(e) => {
                              const tiers = { ...(row.price_tiers || {}) };
                              tiers[qty] = parseFloat(e.target.value || '0');
                              updateRow(i, { price_tiers: tiers });
                            }}
                            className="form-input !py-1 !px-2 text-sm flex-1 max-w-[180px]"
                            title="Total price for this quantity"
                          />
                          <span className="text-xs text-zinc-500">{row.currency}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const tiers = { ...(row.price_tiers || {}) };
                              delete tiers[qty];
                              updateRow(i, { price_tiers: tiers });
                            }}
                            className="text-red-500 hover:text-red-700"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    <button
                      type="button"
                      onClick={() => {
                        const tiers = { ...(row.price_tiers || {}) };
                        // Pick the next qty that isn't already used.
                        let nextQty = 2;
                        while (tiers[String(nextQty)] !== undefined) nextQty++;
                        tiers[String(nextQty)] = row.price * nextQty;
                        updateRow(i, { price_tiers: tiers });
                      }}
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-electric-blue hover:underline"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add tier
                    </button>
                  </div>
                )}
              </div>
              </div>
            ))}
          </div>
        </section>

        {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2 text-xs text-red-700">✗ {error}</div>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-5 py-2 rounded-xl text-sm shadow-[0_0_25px_rgba(59,130,246,0.3)] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {busy ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}
          </button>
          <Link to="/admin/products" className="text-sm font-bold text-zinc-600 hover:text-electric-blue">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider font-bold text-zinc-500 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-zinc-500 mt-1">{hint}</p>}
    </div>
  );
}
