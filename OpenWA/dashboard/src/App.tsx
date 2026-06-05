import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RoleProvider, useRole, type UserRole } from './hooks/useRole';
import { SessionProvider } from './hooks/useActiveSession';
import { ErrorBoundary } from './components/ErrorBoundary';
import { supabaseSignOut } from './lib/supabase';
import './App.css';

const Login           = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Landing         = lazy(() => import('./pages/Landing'));
const AdminApprovals  = lazy(() => import('./pages/AdminApprovals').then(m => ({ default: m.AdminApprovals })));
const SystemSettings  = lazy(() => import('./pages/SystemSettings').then(m => ({ default: m.SystemSettings })));
const Dashboard       = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions        = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Webhooks        = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Logs            = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys         = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester   = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Infrastructure  = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins         = lazy(() => import('./pages/Plugins'));
const BotFunnel       = lazy(() => import('./pages/BotFunnel'));
const CreateServiceForm = lazy(() => import('./components/CreateServiceForm'));
const Conversations   = lazy(() => import('./pages/Conversations'));
const Integrations    = lazy(() => import('./pages/Integrations').then(m => ({ default: m.Integrations })));
const Billing         = lazy(() => import('./pages/Billing').then(m => ({ default: m.Billing })));
const AdminSubscriptions = lazy(() => import('./pages/AdminSubscriptions').then(m => ({ default: m.AdminSubscriptions })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Boot state. After login:
  //   - admin and seller both end up with `openwa_api_key` set (admin
  //     gets the gateway's master key from brain). Admin additionally
  //     gets a Supabase access_token + role='admin' in sessionStorage,
  //     which Layout uses to swap the nav.
  const savedKey = sessionStorage.getItem('openwa_api_key');
  const savedRole = sessionStorage.getItem('codhelix_role') as UserRole | null;

  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const { setRole, role } = useRole();

  // Hydrate role on first render if we have one stashed (avoids a flash
  // of seller nav before /api/auth/validate completes).
  useEffect(() => {
    if (savedRole && !role) setRole(savedRole);
  }, [savedRole, role, setRole]);

  const handleLogin = async (key: string) => {
    // Defensive: Login.tsx no longer uses the __codhelix_admin__ sentinel,
    // but treat it as "use whatever's in sessionStorage" if it ever comes
    // back, so older sessions don't break.
    if (key === '__codhelix_admin__') {
      setIsAuthenticated(true);
      setRole('admin');
      return;
    }

    setApiKey(key);
    sessionStorage.setItem('openwa_api_key', key);

    // If we just signed in as admin, the role is already in sessionStorage —
    // honour it without round-tripping /api/auth/validate (which would
    // return 'admin' from the gateway's master key anyway, but skipping
    // the network call avoids a flash).
    const stashed = sessionStorage.getItem('codhelix_role');
    if (stashed === 'admin') {
      setRole('admin');
      setIsAuthenticated(true);
      return;
    }

    try {
      const response = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'X-API-Key': key },
      });
      if (response.ok) {
        const data = await response.json();
        setRole(data.role as UserRole);
      }
    } catch {
      setRole('viewer');
    }
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    // Drop any Google/Supabase session too (best-effort, never throws).
    void supabaseSignOut();
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.removeItem('codhelix_admin_token');
    sessionStorage.removeItem('codhelix_role');
    sessionStorage.removeItem('codhelix_email');
    sessionStorage.removeItem('leadecombot_seller_id');
    sessionStorage.removeItem('leadecombot_business_name');
  };

  // Re-validate gateway key on mount for non-admin sessions only. Admin
  // sessions already have the right role in sessionStorage; the gateway
  // would happily reply with 'admin' too, but we want a single source of
  // truth for the platform role.
  useEffect(() => {
    if (!savedKey) return;
    if (sessionStorage.getItem('codhelix_role') === 'admin') return;

    fetch('/api/auth/validate', {
      method: 'POST',
      headers: { 'X-API-Key': savedKey },
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid && data.role) {
          setRole(data.role as UserRole);
        }
      })
      .catch(() => {
        // Keep existing role from sessionStorage if validation fails
      });
  }, [savedKey, setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  // Public (signed-out) surface. The landing page is the entry point at
  // "/", with dedicated /login and /signup routes. Anything else bounces
  // back to the landing page. Once authenticated we fall through to the
  // app router below.
  if (!isAuthenticated) {
    return (
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/"       element={<Landing />} />
            <Route path="/login"  element={<Login onLogin={handleLogin} initialMode="signin" />} />
            <Route path="/signup" element={<Login onLogin={handleLogin} initialMode="signup" />} />
            <Route path="*"       element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    );
  }

  // Both sellers and admin use the full Layout. The sidebar nav is
  // filtered by role inside Layout.tsx; admin gets extra cross-tenant
  // routes (/approvals, /system-settings) that we mount only when
  // role === 'admin'.
  const isAdmin = role === 'admin';

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
        <Routes>
          {/* SessionProvider wraps Layout so BOTH the top-bar SessionSwitcher
              and every nested page (rendered through Layout's <Outlet/>) read
              the same "which WhatsApp number am I viewing?" state. */}
          <Route path="/" element={<SessionProvider><Layout onLogout={handleLogout} userRole={role} /></SessionProvider>}>
            {/* Default landing depends on role: admin → Approvals,
                seller → Dashboard. */}
            <Route index element={isAdmin ? <Navigate to="/approvals" replace /> : <Dashboard />} />

            {/* Admin-only routes */}
            {isAdmin && <Route path="approvals"           element={<AdminApprovals />} />}
            {isAdmin && <Route path="admin/subscriptions" element={<AdminSubscriptions />} />}
            {isAdmin && <Route path="system-settings"     element={<SystemSettings />} />}

            {/* Shared routes */}
            <Route path="sessions" element={<Sessions />} />
            <Route path="logs"     element={<Logs />} />

            {/* Seller-only. The old single "Bot Funnel" is now TWO strictly
                separated surfaces so a seller never sees products and
                services mixed: /funnel = E-commerce COD (kind=product),
                /services = Services & Réservations (kind=service). Both
                render the same component with a fixed `kind`. */}
            {!isAdmin && <Route path="funnel"        element={<BotFunnel kind="product" />} />}
            {!isAdmin && <Route path="services"      element={<BotFunnel kind="service" />} />}
            {/* Hidden preview of the new Tailwind "Nouveau Service" form — not in the sidebar. */}
            {!isAdmin && <Route path="services/preview" element={<CreateServiceForm onCancel={() => window.history.back()} onCreate={(d) => console.log('[CreateServiceForm] payload', d)} />} />}
            {!isAdmin && <Route path="conversations" element={<Conversations />} />}
            {!isAdmin && <Route path="integrations"  element={<Integrations />} />}
            {!isAdmin && <Route path="billing"       element={<Billing />} />}

            {/* Admin-only ops surface */}
            {isAdmin && <Route path="webhooks"       element={<Webhooks />} />}
            {isAdmin && <Route path="api-keys"      element={<ApiKeys />} />}
            {isAdmin && <Route path="message-tester" element={<MessageTester />} />}
            {isAdmin && <Route path="infrastructure" element={<Infrastructure />} />}
            {isAdmin && <Route path="plugins"        element={<Plugins />} />}

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
