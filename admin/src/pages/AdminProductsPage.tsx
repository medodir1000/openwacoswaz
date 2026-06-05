import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Package, Loader2, Globe2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  status: 'active' | 'out_of_stock' | 'archived';
  created_at: string;
  product_countries: { country_code: string; language_code: string; price: number; currency: string }[];
};

export default function AdminProductsPage() {
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, description, image_url, status, created_at, product_countries(country_code, language_code, price, currency)')
      .order('created_at', { ascending: false });
    if (error) { setError(error.message); setRows([]); return; }
    setRows((data ?? []) as ProductRow[]);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="p-10 max-w-6xl space-y-8">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Catalog</p>
          <h1 className="text-4xl font-black tracking-tighter mt-1">Products</h1>
          <p className="text-zinc-500 text-sm mt-1">What the bot sells. Add one product per row; price + language vary per country.</p>
        </div>
        <Link to="/admin/products/new" className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-5 py-2 rounded-xl text-sm shadow-[0_0_25px_rgba(59,130,246,0.3)]">
          <Plus className="w-4 h-4" /> Add product
        </Link>
      </div>

      {!rows && <p className="text-zinc-500 text-sm">{error ? `✗ ${error}` : 'Loading…'}</p>}

      {rows && rows.length === 0 && (
        <div className="glass-card rounded-2xl p-12 text-center">
          <Package className="w-10 h-10 text-zinc-400 mx-auto mb-3" />
          <p className="text-zinc-600 text-sm mb-4">No products yet. Add the first one — bot can't sell until it knows what's on offer.</p>
          <Link to="/admin/products/new" className="inline-flex items-center gap-2 bg-electric-blue !text-white font-bold px-4 py-2 rounded-xl text-sm">
            <Plus className="w-4 h-4" /> Add your first product
          </Link>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(rows || []).map((p) => (
          <Link to={`/admin/products/${p.id}`} key={p.id} className="glass-card rounded-2xl overflow-hidden hover:border-electric-blue/40 transition-colors block">
            <div className="aspect-[16/10] bg-zinc-100">
              {p.image_url
                ? <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" loading="lazy" />
                : <div className="w-full h-full flex items-center justify-center text-zinc-300"><Package className="w-10 h-10" /></div>}
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-bold text-zinc-900 truncate">{p.name}</h3>
                {p.status !== 'active' && (
                  <span className="text-[10px] uppercase tracking-widest font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{p.status.replace('_', ' ')}</span>
                )}
              </div>
              {p.description && <p className="text-xs text-zinc-500 line-clamp-2 mb-2">{p.description}</p>}
              <div className="flex flex-wrap gap-1 mt-2">
                {(p.product_countries || []).slice(0, 5).map((pc) => (
                  <span key={pc.country_code} className="inline-flex items-center gap-1 text-[10px] font-bold text-electric-blue bg-electric-blue/10 px-1.5 py-0.5 rounded">
                    <Globe2 className="w-2.5 h-2.5" />
                    {pc.country_code}·{pc.price} {pc.currency}
                  </span>
                ))}
                {(p.product_countries?.length || 0) > 5 && (
                  <span className="text-[10px] text-zinc-500">+{(p.product_countries?.length || 0) - 5} more</span>
                )}
                {(p.product_countries?.length || 0) === 0 && (
                  <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-bold inline-flex items-center gap-1">
                    {(<Loader2 className="w-2.5 h-2.5" />)} no country rows — bot can't price it yet
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
