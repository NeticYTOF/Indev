#!/usr/bin/env node
/**
 * CANONICAL UI-verification launcher (fail closed).
 *
 * The class of bug this kills: a UI session silently served by a LIVE
 * server. This launcher:
 *  1. uses ISOLATED ports (server 8788, vite 5174) so a stale process can
 *     never answer instead of ours;
 *  2. verifies /api/health reports mock:true, and exits non-zero otherwise;
 *  3. verifies a plan response is actually synthetic (source === 'synthetic');
 *  4. prints a READY line only after both checks pass;
 *  5. fails loudly if either port is already occupied.
 *
 * Repo root data is untouched: the mock server runs with a throwaway data
 * dir. Kill with Ctrl+C (both children are cleaned up).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRV_PORT = Number(process.env.UIV_SERVER_PORT || 8788);
const WEB_PORT = Number(process.env.UIV_WEB_PORT || 5174);
const DATA_DIR = join(ROOT, '.tmp-ui-verify-data');

/** Live credentials/AI config NEVER pass into the mock UI-test children. */
const CREDENTIAL_KEYS = ['STATIQ_API_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'];
function sanitizedChildEnv() {
  const env = { ...process.env };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  return env;
}

/** Probe health on a base URL; returns health JSON or null. */
async function probeHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 400, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function probeSyntheticPlan(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
        destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.plan?.source === 'synthetic' && body?.plan?.stops?.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  // 0) fail fast if the ports are already serving something
  for (const [label, port] of [['server', SRV_PORT], ['web', WEB_PORT]]) {
    const host = label === 'server' ? '127.0.0.1' : 'localhost';
    const health = await probeHealth(`http://${host}:${port}`);
    if (health) {
      console.error(`FAIL-CLOSED: port ${port} (${label}) is already serving. Stop it first.`);
      process.exit(1);
    }
  }

  // 1) mock server on an isolated port with a throwaway data dir
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const server = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...sanitizedChildEnv(),
        INDEV_MOCK: '1',
        PORT: String(SRV_PORT),
        DATA_DIR: DATA_DIR,
        // never even load the repo .env: no live credentials in this process
        INDEV_SKIP_DOTENV: '1',
        INDEV_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => {
    serverLog += d;
    process.stdout.write(`[server] ${d}`);
  });
  server.stderr.on('data', (d) => {
    serverLog += d;
    process.stderr.write(`[server] ${d}`);
  });

  const shutdown = (code = 1) => {
    server.kill();
    web?.kill();
    setTimeout(() => process.exit(code), 300).unref();
  };
  let web = null;

  try {
    // 2) wait for health and FAIL CLOSED unless mock is true
    const health = await waitFor(() => probeHealth(`http://127.0.0.1:${SRV_PORT}`), {
      label: 'mock server health',
    });
    if (health.mock !== true) {
      console.error(`FAIL-CLOSED: server reports mock: ${health.mock}. Refusing to serve UI verification.`);
      shutdown(1);
      return;
    }
    const startupLine = serverLog.split('\n').find((l) => l.includes('mock:')) ?? '(no startup line)';
    console.log(`[gate] startup line verified -> ${startupLine.trim()}`);
    console.log('[gate] /api/health mock=true verified.');
    console.log('[gate] credential-free stack: live credentials/AI config stripped from children; .env skipped.');

    // 3) synthetic-plan probe
    const syntheticOk = await probeSyntheticPlan(`http://127.0.0.1:${SRV_PORT}`);
    if (!syntheticOk) {
      console.error('FAIL-CLOSED: plan response is not synthetic (source !== "synthetic").');
      shutdown(1);
      return;
    }
    console.log('[gate] synthetic plan probe verified (source === "synthetic").');

    // 4) vite on an isolated port proxying to our verified server
    web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'serve', 'apps/web', '--port', String(WEB_PORT), '--strictPort'], {
      cwd: ROOT,
      env: { ...sanitizedChildEnv(), API_PROXY_TARGET: `http://127.0.0.1:${SRV_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    web.stdout.on('data', (d) => process.stdout.write(`[web] ${d}`));
    web.stderr.on('data', (d) => process.stderr.write(`[web] ${d}`));

    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://localhost:${WEB_PORT}/`, { signal: AbortSignal.timeout(2000) });
          return res.ok;
        } catch {
          return false;
        }
      },
      { label: 'vite dev server' },
    );

    console.log(`READY ui-verify: web http://localhost:${WEB_PORT} (mock server :${SRV_PORT}, fail-closed checks passed)`);

    // 5) keep running until interrupted
    await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]);
    shutdown(0);
  } catch (err) {
    console.error(`FAIL-CLOSED: ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  void main();
}

export { probeHealth, probeSyntheticPlan, waitFor };
