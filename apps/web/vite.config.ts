import { defineConfig, type PluginOption } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { basecoatSubset } from './basecoat-subset';

// The API proxy target is configurable so isolated verification stacks can
// point Vite at their own server port (see scripts/ui-verify.mjs).
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  // Tailwind v4 compiles the Basecoat (shadcn/ui-style) component layer;
  // only its theme layer is loaded, not preflight or utilities (see
  // src/ui/theme.css). The cast bridges the plugin's types, which resolve
  // against vitest's newer Vite copy; the runtime hooks match Vite 6.
  plugins: [basecoatSubset(), tailwindcss() as unknown as PluginOption],
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
