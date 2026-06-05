import { useRef, useState } from 'react';

/* ============================================================================
   CreateServiceForm — premium "Nouveau Service" form (React + Tailwind CSS).
   Self-contained: no UI library, inline SVG icons, emerald (Closwiz green)
   primary. Drop-in component; wire onCancel / onCreate to your app.

   NOTE: requires Tailwind CSS in the project. If your app isn't on Tailwind,
   see the chat note for the two integration paths.
   ========================================================================== */

type CustomField = { id: string; label: string; required: boolean };

export interface ServicePayload {
  name: string;
  aliases: string[];
  description: string;
  images: string[];
  fields: CustomField[];
  webhook: string;
  country: string;
  language: string;
  price: string;
  currency: string;
}

const MAX_IMAGES = 5;
const DESC_MAX = 600;

const COUNTRIES = [
  ['MA', '🇲🇦 Maroc'], ['SN', '🇸🇳 Sénégal'], ['CI', "🇨🇮 Côte d'Ivoire"],
  ['GN', '🇬🇳 Guinée'], ['CM', '🇨🇲 Cameroun'], ['EG', '🇪🇬 Égypte'],
] as const;
const LANGS = [['fr', 'Français'], ['ar', 'العربية'], ['ary', 'Darija'], ['en', 'English']] as const;
const CURRENCIES = ['MAD', 'XOF', 'GNF', 'XAF', 'EGP', 'USD'] as const;
const COUNTRY_CCY: Record<string, string> = { MA: 'MAD', SN: 'XOF', CI: 'XOF', GN: 'GNF', CM: 'XAF', EG: 'EGP' };

export default function CreateServiceForm({
  onCancel,
  onCreate,
  whatsappNumbers = ['+212 728 446 660', '+212 661 234 567'],
}: {
  onCancel?: () => void;
  onCreate?: (data: ServicePayload) => void;
  whatsappNumbers?: string[];
}) {
  const [name, setName] = useState('');
  const [aliasInput, setAliasInput] = useState('');
  const [aliases, setAliases] = useState<string[]>(['biorein', 'bio rein']);
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [fields, setFields] = useState<CustomField[]>([
    { id: 'f-name', label: 'Nom complet', required: true },
    { id: 'f-phone', label: 'Téléphone', required: true },
  ]);
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>(whatsappNumbers.slice(0, 1));
  const [webhook, setWebhook] = useState('');
  const [country, setCountry] = useState('MA');
  const [language, setLanguage] = useState('fr');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('MAD');
  const fileRef = useRef<HTMLInputElement>(null);

  /* ── handlers ─────────────────────────────────────────────────────────── */
  const commitAlias = (raw: string) => {
    const t = raw.trim().replace(/,+$/, '').trim();
    if (t && !aliases.includes(t)) setAliases((a) => [...a, t]);
    setAliasInput('');
  };
  const onAliasKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitAlias(aliasInput); }
    else if (e.key === 'Backspace' && !aliasInput && aliases.length) setAliases((a) => a.slice(0, -1));
  };
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const room = MAX_IMAGES - images.length;
    const urls = Array.from(files).slice(0, room).filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f));
    if (urls.length) setImages((p) => [...p, ...urls]);
  };
  const pickCountry = (c: string) => { setCountry(c); if (COUNTRY_CCY[c]) setCurrency(COUNTRY_CCY[c]); };
  const toggleNumber = (n: string) =>
    setSelectedNumbers((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate?.({ name, aliases, description, images, fields, webhook, country, language, price, currency });
  };

  const canCreate = name.trim().length >= 3 && selectedNumbers.length > 0;

  /* ── render ───────────────────────────────────────────────────────────── */
  return (
    <div className="tw min-h-screen w-full overflow-y-auto bg-slate-50 px-4 py-10">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_24px_60px_-24px_rgba(15,23,42,0.25)]"
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header className="flex items-start gap-4 border-b border-slate-100 px-7 py-6">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/30">
            <Icon name="bot" className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Nouveau Service</h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                <Icon name="calendar" className="h-3 w-3" /> Service
              </span>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Le bot détecte le service, collecte les infos client et confirme la réservation.
            </p>
          </div>
        </header>

        <div className="space-y-7 px-7 py-7">
          {/* ── 1. Identité ──────────────────────────────────────────────── */}
          <Section icon="tag" title="Identité" hint="Le nom du service + les variantes que vos clients tapent.">
            <Field label="Nom du service" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex. Biorein — cure détox"
                className={inputCls}
              />
            </Field>

            <Field label="Noms & alias du service" hint="Tapez puis Entrée ou virgule. Aide le bot à reconnaître le service.">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
                {aliases.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 py-1 pl-2.5 pr-1.5 text-sm font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    {a}
                    <button type="button" onClick={() => setAliases((al) => al.filter((x) => x !== a))}
                      className="grid h-4 w-4 place-items-center rounded text-emerald-500 transition hover:bg-emerald-200/60 hover:text-emerald-800" aria-label={`Retirer ${a}`}>
                      <Icon name="x" className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={onAliasKey}
                  onBlur={() => commitAlias(aliasInput)}
                  placeholder={aliases.length ? 'Ajouter…' : 'biorein, bio rein…'}
                  className="min-w-[120px] flex-1 border-0 bg-transparent p-0.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                />
              </div>
            </Field>
          </Section>

          {/* ── 2. Description / Prompt ──────────────────────────────────── */}
          <Section icon="doc" title="Description / Prompt du bot" hint="Tout le contexte : déroulé, tarifs, conditions — le bot le lit pour répondre.">
            <div className="relative">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
                rows={5}
                placeholder="Ex. Cure détox de 10 jours. Séance à domicile, prise de RDV, tarif 350 MAD/séance…"
                className={`${inputCls} resize-none leading-relaxed`}
              />
              <span className={`pointer-events-none absolute bottom-2.5 right-3 text-xs tabular-nums ${description.length > DESC_MAX - 60 ? 'text-amber-500' : 'text-slate-400'}`}>
                {description.length}/{DESC_MAX}
              </span>
            </div>
          </Section>

          {/* ── 3. Photos ────────────────────────────────────────────────── */}
          <Section icon="image" title="Photos du service" hint={`Jusqu'à ${MAX_IMAGES} images. Glissez-déposez ou cliquez.`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {images.map((src, i) => (
                <div key={i} className="group relative aspect-square overflow-hidden rounded-xl ring-1 ring-slate-200">
                  <img src={src} alt="" className="h-full w-full object-cover" />
                  <button type="button" onClick={() => setImages((im) => im.filter((_, j) => j !== i))}
                    className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 hover:bg-black/75" aria-label="Supprimer l'image">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                  className={`flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed text-center transition ${
                    dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50 hover:border-emerald-400 hover:bg-emerald-50/50'
                  }`}
                >
                  <Icon name="upload" className={`h-6 w-6 ${dragOver ? 'text-emerald-600' : 'text-slate-400'}`} />
                  <span className="px-1 text-[11px] font-medium leading-tight text-slate-500">Glissez ou cliquez</span>
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
          </Section>

          {/* ── 4. Informations à collecter (custom fields) ──────────────── */}
          <Section icon="list" title="Informations à collecter" hint="Ce que le bot demandera au client avant de confirmer.">
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={f.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <Icon name="grip" className="h-4 w-4 shrink-0 text-slate-300" />
                  <input
                    value={f.label}
                    onChange={(e) => setFields((fl) => fl.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    placeholder="Nom du champ (ex. Adresse, Date du RDV…)"
                    className="flex-1 border-0 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-500 select-none">
                    <input type="checkbox" checked={f.required}
                      onChange={(e) => setFields((fl) => fl.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                    Requis
                  </label>
                  <button type="button" onClick={() => setFields((fl) => fl.filter((_, j) => j !== i))}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-500" aria-label="Retirer le champ">
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setFields((fl) => [...fl, { id: `f-${fl.length}-${Math.random().toString(36).slice(2, 6)}`, label: '', required: false }])}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:border-emerald-400 hover:bg-emerald-50/60 hover:text-emerald-700">
              <Icon name="plus" className="h-4 w-4" /> Ajouter un champ
            </button>
          </Section>

          {/* ── 5. Routage & Webhook ─────────────────────────────────────── */}
          <Section icon="radio" title="Disponibilité & routage" hint="Les numéros WhatsApp qui gèrent ce service + l'export des commandes.">
            <Field label="Numéros WhatsApp" required>
              <div className="flex flex-wrap gap-2">
                {whatsappNumbers.map((n) => {
                  const on = selectedNumbers.includes(n);
                  return (
                    <button key={n} type="button" onClick={() => toggleNumber(n)}
                      className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition ${
                        on ? 'border-emerald-500 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-500/20' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}>
                      <span className={`grid h-4 w-4 place-items-center rounded-full text-white ${on ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                        {on && <Icon name="check" className="h-3 w-3" />}
                      </span>
                      {n}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Webhook de commande (Google Sheets)" hint="Chaque réservation confirmée sera poussée vers cette feuille.">
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 transition focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
                <Icon name="sheet" className="h-4 w-4 shrink-0 text-emerald-600" />
                <input value={webhook} onChange={(e) => setWebhook(e.target.value)}
                  placeholder="https://script.google.com/macros/s/…/exec"
                  className="flex-1 border-0 bg-transparent py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400" />
              </div>
            </Field>
          </Section>

          {/* ── 6. Prix ──────────────────────────────────────────────────── */}
          <Section icon="cash" title="Prix" hint="Tarif affiché au client. La devise suit le pays.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Pays">
                <select value={country} onChange={(e) => pickCountry(e.target.value)} className={`${inputCls} appearance-none pr-8`}>
                  {COUNTRIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                </select>
              </Field>
              <Field label="Langue">
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className={`${inputCls} appearance-none pr-8`}>
                  {LANGS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                </select>
              </Field>
              <Field label="Prix">
                <input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="350" className={inputCls} />
              </Field>
              <Field label="Devise">
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${inputCls} appearance-none pr-8`}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>
          </Section>
        </div>

        {/* ── Footer (sticky actions) ──────────────────────────────────── */}
        <footer className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-slate-100 bg-white/90 px-7 py-4 backdrop-blur">
          <button type="button" onClick={onCancel}
            className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">
            Annuler
          </button>
          <button type="submit" disabled={!canCreate}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:from-emerald-600 hover:to-emerald-700 hover:shadow-emerald-500/40 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none">
            <Icon name="sparkle" className="h-4 w-4" /> Créer le service
          </button>
        </footer>
      </form>
    </div>
  );
}

/* ── shared input class ─────────────────────────────────────────────────── */
const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20';

/* ── Section wrapper: icon badge + title + helper ───────────────────────── */
function Section({ icon, title, hint, children }: {
  icon: IconName; title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-100 bg-slate-50/40 p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-emerald-600 ring-1 ring-slate-200">
          <Icon name={icon} className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h2 className="text-[13px] font-bold uppercase tracking-wider text-slate-700">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/* ── Field: label (+ required/optional + hint) over its control ─────────── */
function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
        {label}
        {required
          ? <span className="text-emerald-500">*</span>
          : <span className="text-xs font-normal text-slate-400">· optionnel</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

/* ── inline icon set (no external dependency) ───────────────────────────── */
type IconName = 'bot' | 'calendar' | 'tag' | 'doc' | 'image' | 'list' | 'radio' | 'cash' | 'plus' | 'x' | 'trash' | 'upload' | 'check' | 'grip' | 'sheet' | 'sparkle';
function Icon({ name, className }: { name: IconName; className?: string }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<IconName, React.ReactNode> = {
    bot: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V5" /><circle cx="12" cy="3.5" r="1.2" /><path d="M9 13h.01M15 13h.01M9.5 17h5" /></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    tag: <><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.2" /></>,
    doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>,
    radio: <><circle cx="12" cy="12" r="2" /><path d="M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 16.24a6 6 0 0 1 0-8.49M16.24 7.76a6 6 0 0 1 0 8.49" /></>,
    cash: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    x: <><path d="M18 6 6 18M6 6l12 12" /></>,
    trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></>,
    check: <><path d="M20 6 9 17l-5-5" /></>,
    grip: <><circle cx="9" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="18" r="1" /></>,
    sheet: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 3v18" /></>,
    sparkle: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /></>,
  };
  return <svg viewBox="0 0 24 24" className={className} {...p}>{paths[name]}</svg>;
}
