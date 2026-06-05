import { useEffect, useMemo, useState } from 'react';
import { ShoppingBag, RefreshCw, FileSpreadsheet, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

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
  status: 'pending' | 'confirmed' | 'dispatched' | 'delivered' | 'cancelled';
  sheets_sync_status: 'pending' | 'synced' | 'failed';
  sheets_sync_at: string | null;
  created_at: string;
  products: { name: string } | null;
};

const STATUS_TABS = ['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'] as const;

export default function AdminOrdersPage() {
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [filter, setFilter] = useState<typeof STATUS_TABS[number]>('confirmed');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    const { data, error } = await supabase
      .from('orders')
      .select('id, customer_name, customer_phone, customer_address, customer_city, country_code, quantity, unit_price, total_price, currency, status, sheets_sync_status, sheets_sync_at, created_at, products(name)')
      .order('created_at', { ascending: false })
      .limit(200);
    setBusy(false);
    if (error) { console.error(error); setRows([]); return; }
    setRows((data ?? []) as unknown as OrderRow[]);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, confirmed: 0, dispatched: 0, delivered: 0, cancelled: 0 };
    (rows || []).forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [rows]);

  const filtered = useMemo(() => (rows || []).filter(r => r.status === filter), [rows, filter]);

  return (
    <div className="p-10 max-w-7xl space-y-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Sales</p>
          <h1 className="text-4xl font-black tracking-tighter mt-1">Orders</h1>
          <p className="text-zinc-500 text-sm mt-1">Each row = one confirmed conversation. Sync status shows whether it landed in your Google Sheet.</p>
        </div>
        <button type="button" onClick={load} disabled={busy} className="inline-flex items-center gap-2 bg-white border border-zinc-200 rounded-xl px-4 py-2 text-sm font-bold hover:border-electric-blue hover:text-electric-blue disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-zinc-200 pb-3">
        {STATUS_TABS.map((s) => (
          <button key={s} type="button" onClick={() => setFilter(s)}
            className={
              'inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-[0.15em] border transition-colors ' +
              (filter === s ? 'bg-electric-blue !text-white border-electric-blue' : 'bg-white text-zinc-600 border-zinc-200 hover:border-electric-blue hover:text-electric-blue')
            }
          >
            {s}
            <span className={(filter === s ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600') + ' rounded-full px-2 py-0.5 text-[10px] font-black leading-none'}>
              {counts[s] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {!rows && <p className="text-zinc-500 text-sm">Loading…</p>}

      {rows && filtered.length === 0 && (
        <div className="glass-card rounded-2xl p-12 text-center">
          <ShoppingBag className="w-10 h-10 text-zinc-400 mx-auto mb-3" />
          <p className="text-zinc-600 text-sm">No <strong>{filter}</strong> orders yet.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="glass-card rounded-2xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-zinc-50 border-b border-zinc-200">
              <tr className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">
                <th className="text-left px-4 py-3">When</th>
                <th className="text-left px-4 py-3">Product</th>
                <th className="text-left px-4 py-3">Customer</th>
                <th className="text-left px-4 py-3">Phone</th>
                <th className="text-left px-4 py-3">Address</th>
                <th className="text-right px-4 py-3">Qty</th>
                <th className="text-right px-4 py-3">Total</th>
                <th className="text-left px-4 py-3">Sheets</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50">
                  <td className="px-4 py-3 text-xs text-zinc-600">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm font-bold text-zinc-900">{o.products?.name || '—'}</td>
                  <td className="px-4 py-3 text-sm text-zinc-900">{o.customer_name || '—'}</td>
                  <td className="px-4 py-3 text-sm font-mono text-zinc-700 whitespace-nowrap">
                    {o.customer_phone
                      ? <a href={`https://wa.me/${o.customer_phone.replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer" className="hover:text-electric-blue">{o.customer_phone}</a>
                      : <span className="text-zinc-400 italic font-sans text-xs">no phone</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 max-w-xs truncate">{[o.customer_address, o.customer_city, o.country_code].filter(Boolean).join(', ')}</td>
                  <td className="px-4 py-3 text-sm text-right font-bold">{o.quantity}</td>
                  <td className="px-4 py-3 text-sm text-right font-black text-zinc-900">{o.total_price} {o.currency}</td>
                  <td className="px-4 py-3 text-xs">
                    {o.sheets_sync_status === 'synced'
                      ? <span className="inline-flex items-center gap-1 text-green-700 font-bold"><FileSpreadsheet className="w-3.5 h-3.5" /> synced</span>
                      : o.sheets_sync_status === 'failed'
                        ? <span className="text-red-700 font-bold">✗ failed</span>
                        : <span className="text-amber-700 font-bold">pending</span>}
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
