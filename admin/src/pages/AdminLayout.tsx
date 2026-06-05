import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, MessageSquare, ShoppingBag,
  MessageCircle, Settings, LogOut,
} from 'lucide-react';
import { useAuth } from '../lib/AuthContext';

const NAV = [
  { to: '/admin',                label: 'Dashboard',     icon: LayoutDashboard, end: true },
  { to: '/admin/whatsapp',       label: 'WhatsApp',      icon: MessageCircle },
  { to: '/admin/products',       label: 'Products',      icon: Package },
  { to: '/admin/orders',         label: 'Orders',        icon: ShoppingBag },
  { to: '/admin/conversations',  label: 'Conversations', icon: MessageSquare },
  { to: '/admin/settings',       label: 'Settings',      icon: Settings },
];

export default function AdminLayout() {
  const { user, profile, signOut } = useAuth();
  const nav = useNavigate();

  async function handleLogout() {
    await signOut();
    nav('/login');
  }

  return (
    <div className="min-h-screen flex bg-zinc-50">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-zinc-200 flex flex-col bg-white">
        <div className="p-5 border-b border-zinc-200">
          <p className="font-black tracking-tighter text-lg">leadecom<span className="text-electric-blue">bot</span></p>
          <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-500 mt-0.5">{profile?.role}</p>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-bold transition-colors ' +
                (isActive
                  ? 'bg-electric-blue/10 text-electric-blue'
                  : 'text-zinc-600 hover:bg-zinc-100')
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-zinc-200">
          <p className="text-[10px] text-zinc-500 mb-2 truncate px-1" title={user?.email || ''}>{user?.email}</p>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-zinc-600 hover:bg-zinc-100"
          >
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
