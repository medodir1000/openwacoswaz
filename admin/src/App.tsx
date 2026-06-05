import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import SignupCompletePage from './pages/SignupCompletePage';
import AdminLayout from './pages/AdminLayout';
import AdminDashboard from './pages/AdminDashboard';
import AdminWhatsappPage from './pages/AdminWhatsappPage';
import AdminProductsPage from './pages/AdminProductsPage';
import AdminProductEditor from './pages/AdminProductEditor';
import AdminOrdersPage from './pages/AdminOrdersPage';
import AdminConversationsPage from './pages/AdminConversationsPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import RequireAuth from './components/RequireAuth';

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      {/* Auth-required but profile-NOT-required (so users with missing
          app_users row don't fall into the RequireAuth redirect loop). */}
      <Route path="/signup/complete" element={<SignupCompletePage />} />

      {/* Admin (auth required) */}
      <Route path="/admin" element={<RequireAuth><AdminLayout /></RequireAuth>}>
        <Route index            element={<AdminDashboard />} />
        <Route path="whatsapp"  element={<AdminWhatsappPage />} />
        <Route path="products"  element={<AdminProductsPage />} />
        <Route path="products/:id" element={<AdminProductEditor />} />
        <Route path="orders"        element={<AdminOrdersPage />} />
        <Route path="conversations" element={<AdminConversationsPage />} />
        <Route path="settings"      element={<AdminSettingsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
