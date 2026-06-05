import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  appType: 'spa', // Enable SPA fallback for client-side routing
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || '0.2.1'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 2886,
    proxy: {
      // Socket.IO transport for the gateway's EventsGateway (namespace
      // `/events`). It carries live session status AND the pairing QR code
      // (onQRCode). Socket.IO always hits the default `/socket.io/` path, so
      // it must be proxied separately from `/api` — and WITH `ws: true`, or
      // the WebSocket upgrade fails and the QR never reaches the dashboard.
      '/socket.io': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:2785',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      // Proxy the leadecombot Bot Funnel endpoints to the Python brain.
      // Brain owns the Supabase backend (products, orders, conversations,
      // bot settings); the dashboard just renders them.
      '/funnel': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
