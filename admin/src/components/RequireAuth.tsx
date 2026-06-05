import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

type Props = {
  children: ReactNode;
  /** If true, also require role='admin'. Sellers will be 403'd. */
  requireAdmin?: boolean;
};

/**
 * Route guard. Bounces unauthenticated users to /login (preserving the
 * intended destination in `state.from` so login can redirect back).
 * When `requireAdmin` is set, sellers without admin role get the 403 page.
 */
export default function RequireAuth({ children, requireAdmin }: Props) {
  const { loading, user, profile } = useAuth();
  const loc = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500 text-xs uppercase tracking-[0.3em] animate-pulse">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }

  // Logged in but no app_users row yet — they need to finish signup.
  if (!profile) {
    return <Navigate to="/signup/complete" replace />;
  }

  if (requireAdmin && profile.role !== 'admin') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="glass-card rounded-2xl p-8 max-w-md text-center">
          <p className="text-xs uppercase tracking-[0.3em] font-bold text-zinc-500 mb-2">403</p>
          <p className="text-zinc-700">This page is admin-only.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
