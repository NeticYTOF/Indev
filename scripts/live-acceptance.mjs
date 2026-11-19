#!/usr/bin/env node
/**
 * LIVE acceptance runner (auditable, bounded, fail-closed).
 *
 * Runs ONE live end-to-end plan against a locally-started LIVE server and
 * captures everything needed to explain the outcome afterwards:
 *  - a UNIQUE run directory (timestamped) that also stores the server log:
 *    server logs are NEVER overwritten across runs;
 *  - the HTTP status and the client exit code captured explicitly;
 *  - the response body saved verbatim for inspection;
 *  - the pass/fail reason printed as a final structured line.
 *
 * The runner NEVER retries: one request, then stop on any outcome.
 * Throttling surfaces as the server's fail-closed not_determined code.
 *
 * Usage: node scripts/live-acceptance.mjs            (live server on :8799)
 *        node scripts/live-acceptance.mjs --mock    (same machinery against a
 *        local MOCK server - used to verify the tooling without upstream)
 *
 * The upstream pacing/fail-closed profile is unchanged: the server-side
 * rate limiter (25/min, 2s gaps, full Retry-After honored, deadline budget)
 * governs every call the runner triggers.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.LIVE_PORT || (MOCK ? 8798 : 8799));
const TIMEOUT_MS = 6 * 60_000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(ROOT, `.tmp-live-run-${stamp}`);
mkdirSync(runDir, { recursive: true });
const serverLogPath = join(runDir, 'server.log');
const planPath = join(runDir, 'plan.json');
const metaPath = join(runDir, 'meta.json');

console.log(`[live-run] dir=${runDir} mode=${MOCK ? 'MOCK-tooling-check' : 'LIVE'} port=${PORT}`);

const serverEnv = { ...process.env, PORT: String(PORT), DATA_DIR: join(runDir, 'data') };
if (MOCK) {
  serverEnv.INDEV_MOCK = '1';
  serverEnv.INDEV_SKIP_DOTENV = '1';
  delete serverEnv.STATIQ_API_TOKEN;
  delete serverEnv.AI_BASE_URL;
  delete serverEnv.AI_API_KEY;
  delete serverEnv.AI_MODEL;
}

const server = spawn(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'],
  { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] },
);

let serverOut = '';
server.stdout.on('data', (d) => {
  const s = String(d);
  serverOut += s;
  process.stdout.write(`[server] ${s}`);
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

/** ONE request; explicit http status + exit code; no retries ever. */
async function runOnce() {
  const started = Date.now();
  const body = JSON.stringify({
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
    startSocPct: 100,
  });
  const res = await fetch(`http://localhost:${PORT}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  return { httpStatus: res.status, ok: res.ok, text, ms: Date.now() - started };
}

(async () => {
  let outcome;
  try {
    // wait for health (bounded)
    const deadline = Date.now() + 30_000;
    let health = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          health = await r.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    if (!health) throw new Error('server did not become healthy within 30s');
    writeFileSync(metaPath, JSON.stringify({ mode: MOCK ? 'mock' : 'live', health, started: new Date().toISOString() }, null, 2));
    console.log(`[live-run] server healthy; mock=${health.mock} (expected ${MOCK})`);

    if (health.mock !== MOCK) {
      throw new Error(`MODE MISMATCH: server mock=${health.mock}, runner expected mock=${MOCK}`);
    }

    const result = await runOnce();
    writeFileSync(planPath, result.text || '(empty response body)');
    outcome = {
      outcome: result.ok ? 'plan-http-ok' : 'plan-http-error',
      httpStatus: result.httpStatus,
      ok: result.ok,
      parse: (() => {
        try {
          const parsed = JSON.parse(result.text);
          if (parsed.error) return { error: parsed.error, code: parsed.code };
          const plan = parsed.plan;
          return {
            source: plan.source,
            status: plan.status,
            stops: plan.stops.length,
            stationsSeen: plan.stationsSeen,
            routeKm: Math.round(plan.routeDistanceKm),
            finalSocPct: plan.totals.finalSocPct,
            stopNames: plan.stops.map((s) => s.station.name),
            warnings: plan.warnings,
          };
        } catch {
          return { parseError: 'response was not valid JSON', head: result.text.slice(0, 200) };
        }
      })(),
      ms: result.ms,
    };
  } catch (err) {
    outcome = {
      outcome: 'runner-error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    server.kill();
  }
  writeFileSync(metaPath, `${JSON.stringify({ ...outcome, serverLog: 'server.log' }, null, 2)}\n`);

  const planMarker = planPath.endsWith('.json') ? 'plan.json' : 'plan.txt';
  console.log(`[live-run] RESULT ${JSON.stringify({ ...outcome, planFile: planMarker })}`);
  console.log(`[live-run] artifacts: server.log -> ${serverLogPath}`);
  process.exit(0);
})();

// persist the server log in the unique run dir when the child exits or on SIGINT
process.on('SIGINT', () => {
  server.kill();
  writeFileSync(serverLogPath, serverOut);
  console.log(`[live-run] interrupted; server log preserved at ${serverLogPath}`);
  process.exit(130);
});
server.on('exit', () => {
  try {
    writeFileSync(serverLogPath, serverOut);
  } catch {
    /* already written */
  }
});
