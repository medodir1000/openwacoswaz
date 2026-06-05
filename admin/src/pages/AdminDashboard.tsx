import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, ShoppingBag, MessageSquare, MessageCircle, ArrowRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';

type Counts = {
  products: number;
  conversations_active: number;
  orders_today: number;
  orders_total: number;
};

export default function AdminDashboard() {
  const { profile } = useAuth();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [seller, setSeller] = useState<{ business_name: string } | null>(null);

  useEffect(() => {
    if (!profile?.seller_id) return;
    (async () => {
      // Fetch counts in parallel via head:true for cheap counting.
      const [sellerRes, productsRes, convosRes, ordersTodayRes, ordersAllRes] = await Promise.all([
        supabase.from('sellers').select('business_name').eq('id', profile.seller_id).maybeSingle(),
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('customer_conversations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
        supabase.from('orders').select('id', { count: 'exact', head: true }),
      ]);
      setSeller((sellerRes.data as { business_name: string } | null) ?? null);
      setCounts({
        products:             productsRes.count ?? 0,
        conversations_active: convosRes.count ?? 0,
        orders_today:         ordersTodayRes.count ?? 0,
        orders_total:         ordersAllRes.count ?? 0,
      });
    })();
  }, [profile?.seller_id]);

  return (
    <div className="p-10 max-w-6xl space-y-8">
      <div>
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Dashboard</p>
        <h1 className="text-4xl font-black tracking-tighter mt-1">
          Welcome{seller ? `, ${seller.business_name}` : ''} 👋
        </h1>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={Package}         label="Active products"      value={counts?.products ?? '…'} />
        <Stat icon={MessageSquare}   label="Active conversations" value={counts?.conversations_active ?? '…'} />
        <Stat icon={ShoppingBag}     label="Orders today"         value={counts?.orders_today ?? '…'} />
        <Stat icon={ShoppingBag}     label="Orders all time"      value={counts?.orders_total ?? '…'} />
      </div>

      <div className="glass-card rounded-2xl p-6">
        <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-600 mb-2">Setup checklist</p>
        <h2 className="text-2xl font-black tracking-tighter mb-4">Get your bot live in 4 steps</h2>
        <ol className="space-y-3">
          <Step n={1} done={(counts?.products ?? 0) > 0}>
            <Link to="/admin/products" className="font-bold text-electric-blue hover:underline inline-flex items-center gap-1">
              Add your first product <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <span className="text-zinc-500 text-sm"> — with per-country language + price</span>
          </Step>
          <Step n={2} done={false /* TODO: read from sellers.sheets_webhook_url */}>
            <Link to="/admin/settings" className="font-bold text-electric-blue hover:underline inline-flex items-center gap-1">
              Paste your Google Sheets webhook URL <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <span className="text-zinc-500 text-sm"> — orders POST straight here</span>
          </Step>
          <Step n={3} done={false /* TODO: read from seller_whatsapp_sessions */}>
            <Link to="/admin/whatsapp" className="font-bold text-electric-blue hover:underline inline-flex items-center gap-1">
              Pair your WhatsApp number <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <span className="text-zinc-500 text-sm"> — QR or 8-digit code</span>
          </Step>
          <Step n={4} done={(counts?.orders_total ?? 0) > 0}>
            Send a test message to yourself from another phone — bot replies with anti-ban human timing.
          </Step>
        </ol>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Package; label: string; value: string | number }) {
  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-electric-blue" />
        <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-500">{label}</p>
      </div>
      <p className="text-3xl font-black tracking-tighter">{value}</p>
    </div>
  );
}

function Step({ n, done, children }: { n: number; done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className={
        'shrink-0 w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-black ' +
        (done ? 'bg-green-100 text-green-700' : 'bg-zinc-100 text-zinc-500')
      }>
        {done ? '✓' : n}
      </span>
      <div className="pt-1">{children}</div>
    </li>
  );
}
