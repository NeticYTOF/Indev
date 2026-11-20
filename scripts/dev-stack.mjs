#!/usr/bin/env node
/**
 * Dev stack for the external visual pass (server :8787 INDEV_MOCK=1, vite :5173).
 *
 * Why this exists: the npm Windows cmd shims (tsx.cmd) can silently drop
 * env vars set in a parent .cmd, which is exactly how a live server once
 * answered the visual pass while the log claimed mock mode. This launcher
 * spawns node + tsx/dist/cli.mjs DIRECTLY (no cmd shims), sets the mock
 * environment in-process, and FAILS CLOSED: it reads /api/health after
 * boot and exits non-zero unless mock is true and a probe plan is
 * synthetic. The startup log line is printed here for the record.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRV_PORT = Number(process.env.DEVSTACK_SERVER_PORT || 8787);
const WEB_PORT = Number(process.env.DEVSTACK_WEB_PORT || 5173);
const DATA_DIR = join(ROOT, '.tmp-ui');

/** Live credentials/AI config NEVER pass into the mock UI-test children. */
const CREDENTIAL_KEYS = ['STATIQ_API_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'];
function sanitizedChildEnv() {
  const env = { ...process.env };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  return env;
}

async function getJson(url, init, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const server = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...sanitizedChildEnv(),
        // set in-process: immune to cmd-shim env dropping
        INDEV_MOCK: '1',
        PORT: String(SRV_PORT),
        DATA_DIR,
        // never even load the repo .env: no live credentials in this process
        INDEV_SKIP_DOTENV: '1',
        INDEV_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let web = null;
  const shutdown = (code = 1) => {
    server.kill();
    web?.kill();
    setTimeout(() => process.exit(code), 300).unref();
  };

  let serverLog = '';
  server.stdout.on('data', (d) => {
    const s = String(d);
    serverLog += s;
    process.stdout.write(`[server] ${s}`);
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    const health = await waitFor(
      () => getJson(`http://localhost:${SRV_PORT}/api/health`),
      30_000,
      'server health',
    );
    const startupLine = serverLog.split('\n').find((l) => l.includes('mock:')) ?? '(no startup line)';
    console.log(`[gate] startup line -> ${startupLine.trim()}`);

    if (health?.mock !== true) {
      console.error(`FAIL-CLOSED: server on :${SRV_PORT} reports mock=${health?.mock}. Killing it.`);
      shutdown(1);
      return;
    }

    const plan = await getJson(`http://localhost:${SRV_PORT}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
        destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
      }),
    });
    if (plan?.plan?.source !== 'synthetic') {
      console.error(`FAIL-CLOSED: plan probe returned source=${plan?.plan?.source}. Killing server.`);
      shutdown(1);
      return;
    }
    console.log('[gate] verified: health.mock=true, plan.source=synthetic.');
    console.log('[gate] credential-free stack: live credentials/AI config stripped from children; .env skipped.');

    web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'serve', 'apps/web', '--port', String(WEB_PORT), '--strictPort'], {
      cwd: ROOT,
      env: { ...sanitizedChildEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    web.stdout.on('data', (d) => process.stdout.write(`[web] ${d}`));
    web.stderr.on('data', (d) => process.stderr.write(`[web] ${d}`));

    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://localhost:${WEB_PORT}/`, { signal: AbortSignal.timeout(1500) });
          return res.ok;
        } catch {
          return false;
        }
      },
      30_000,
      'vite dev server',
    );

    console.log(`READY dev-stack: web http://localhost:${WEB_PORT} (mock server :${SRV_PORT}). Startup line: ${startupLine.trim()}`);
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
