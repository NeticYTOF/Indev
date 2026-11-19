import { defineConfig } from 'vite';

// The API proxy target is configurable so isolated verification stacks can
// point Vite at their own server port (see scripts/ui-verify.mjs).
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
