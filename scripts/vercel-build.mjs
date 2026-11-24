/**
 * Vercel build (Build Output API v3). Produces .vercel/output with:
 *   static/                 the Vite web build
 *   functions/api/index.func  the server bundled into one ESM file
 *   config.json             /api/* -> function, everything else static
 *
 * Bundling the server avoids relying on Vercel resolving the workspace's
 * TypeScript sources (`./env.js` -> env.ts) at runtime.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.vercel', 'output');
rmSync(out, { recursive: true, force: true });

execSync('npm run build -w apps/web', { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'apps', 'web', 'dist'), join(out, 'static'), { recursive: true });

const fn = join(out, 'functions', 'api', 'index.func');
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [join(root, 'apps', 'server', 'src', 'vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundled CJS dependencies may call require(); give ESM a real one.
  banner: { js: "import { createRequire as __indeevCreateRequire } from 'module'; const require = __indeevCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
writeFileSync(join(fn, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  // The sync planning budget is 4 minutes; leave headroom for the response.
  maxDuration: 300,
}, null, 2));
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));

writeFileSync(join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api(?:/.*)?$', dest: '/api/index' },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2));
console.log('Vercel output ready:', out);
