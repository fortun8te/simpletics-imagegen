import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API/image/SSE traffic to the zero-dep Node backend on :8788.
// `npm run build` emits dist/, which the backend serves in local-prod (one URL).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8788',
      '/img': 'http://localhost:8788',
      '/asset': 'http://localhost:8788',
      '/events': { target: 'http://localhost:8788', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
