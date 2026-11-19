#!/usr/bin/env node
/**
 * LIVE acceptance runner (auditable, bounded, fail-closed BY CONSTRUCTION).
 *
 * Runs ONE end-to-end plan against a locally-started server and captures
 * everything needed to explain the outcome afterwards:
 *  - a UNIQUE run directory (timestamped): server logs are NEVER
 *    overwritten across runs, and run artifacts are EVIDENCE - the runner
 *    never deletes or auto-cleans them;
 *  - mode-exclusive child env (buildChildEnv): LIVE runs are pinned
 *    explicit (INDEV_MOCK='0', AI_*='' - presence-pinned empty, so the
 *    repo .env can neither flip the mode nor enable AI; only the
 *    credential channel stays open via .env) and never inherit parent
 *    mock/AI settings; MOCK runs are tokenless by construction (token
 *    stripped, .env skipped) so a mock check can never go live;
 *  - a SOURCE gate: the plan's provenance must match the mode
 *    (mock => synthetic, live => live) - exit is non-zero otherwise;
 *  - the HTTP status and the process exit code captured explicitly
 *    (exitCodeFor): 0 ONLY for plan-ok with matching provenance;
 *  - the response body (or the transport error) saved verbatim;
 *  - the server log persisted on success, failure AND signals.
 *
 * The runner NEVER retries: one request, then stop on any outcome. The
 * first throttle/auth response stops the server-side run (client budget)
 * and surfaces as an honest not_determined body. The runner's fetch
 * window sits just ABOVE the server's 4-minute run budget so the server's
 * own error body (not a local timeout) is the captured artifact.
 *
 * Usage: node scripts/live-acceptance.mjs            (live server on :8799)
 *        node scripts/live-acceptance.mjs --mock    (same machinery, MOCK
 *        server: tokenless, synthetic-plan gate - verifies the tooling
 *        without ever touching upstream)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Server-side run budget (apps/server/src/app.ts) the fetch window aligns to. */
const SERVER_RUN_BUDGET_MS = 4 * 60_000;
/** Default fetch wall: slightly above the server budget so the server's
 *  honest not_determined body lands before any local timeout fires. */
const DEFAULT_FETCH_WALL_MS = SERVER_RUN_BUDGET_MS + 30_000;

/**
 * The runner's fetch wall: the server's EFFECTIVE planning deadline (from
 * /api/health's sanitized runBudget - the authoritative effective config,
 * parent env AND dotenv merged on the server side) plus a 30s slack, so
 * the server's honest not_determined body lands before any local timeout.
 * Absent/malformed there, the DEFAULT_FETCH_WALL_MS fallback applies -
 * exactly the wall the runner used before the derivation existed.
 */
export function fetchWallMs(planDeadlineMs, defaultMs = DEFAULT_FETCH_WALL_MS) {
  if (Number.isFinite(planDeadlineMs) && planDeadlineMs > 0) {
    return planDeadlineMs + 30_000;
  }
  return defaultMs;
}

/**
 * Mode-exclusive child environment. Strips EVERY mode-sensitive variable
 * from the parent, then re-adds exactly what the mode needs:
 *  - live: EXPLICIT live + AI-off, pinned so the repo .env cannot
 *    contaminate them (loadEnv's .env fills only MISSING keys, so an
 *    existing '0'/'' wins by construction - even a .env carrying
 *    INDEV_MOCK=1 or AI_* can never flip this run's mode or AI):
 *      INDEV_MOCK='0'  - explicit live
 *      AI_*=''         - AI disabled (empty values are presence-pinned;
 *                      aiEnabled needs all three truthy)
 *    Only the credential channel stays open: the live server reads
 *    STATIQ_API_TOKEN from the repo .env (or the parent env).
 *  - mock: INDEV_MOCK=1 + INDEV_SKIP_DOTENV=1 and NO token, so the child
 *    is tokenless-by-construction and cannot load live credentials.
 */
export function buildChildEnv(mode, parentEnv) {
  const env = { ...parentEnv };
  if (mode === 'mock') {
    env.INDEV_MOCK = '1';
    env.INDEV_SKIP_DOTENV = '1'; // never even load the repo .env
    delete env.STATIQ_API_TOKEN; // tokenless by construction
    delete env.AI_BASE_URL;
    delete env.AI_API_KEY;
    delete env.AI_MODEL;
  } else {
    delete env.INDEV_SKIP_DOTENV; // live reads the repo .env for the token
    delete env.INDEV_MOCK; // ...then pin explicit values that .env cannot override:
    env.INDEV_MOCK = '0'; // explicit LIVE even if the repo .env says mock
    env.AI_BASE_URL = ''; // AI off by construction (presence-pinned empty)
    env.AI_API_KEY = '';
    env.AI_MODEL = '';
  }
  return env;
}

/**
 * Fail-closed exit status: 0 ONLY for a plan-ok run whose provenance
 * matches the mode. Mode mismatch, source mismatch, HTTP errors, runner
 * errors and anything unknown exit non-zero.
 */
export function exitCodeFor(outcome) {
  if (outcome && outcome.outcome === 'plan-ok' && outcome.sourceMatch === true) {
    return 0;
  }
  return 1;
}

/** Labeled failure that unwinds to a durable outcome (never a bare throw). */
class RunnerFail extends Error {
  constructor(outcome, message) {
    super(message);
    this.outcome = outcome;
  }
}

async function main() {
  const MOCK = process.argv.includes('--mock');
  const PORT = Number(process.env.LIVE_PORT || (MOCK ? 8798 : 8799));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(ROOT, `.tmp-live-run-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const serverLogPath = join(runDir, 'server.log');
  const serverErrPath = join(runDir, 'server-stderr.log');
  const planPath = join(runDir, 'plan.json');
  const metaPath = join(runDir, 'meta.json');

  console.log(`[live-run] dir=${runDir} mode=${MOCK ? 'MOCK-tooling-check' : 'LIVE'} port=${PORT}`);
  console.log('[live-run] run artifacts are evidence: this dir is retained, never auto-cleaned.');

  const serverEnv = {
    ...buildChildEnv(MOCK ? 'mock' : 'live', process.env),
    PORT: String(PORT),
    DATA_DIR: join(runDir, 'data'), // isolated fresh store per run
  };
  if (MOCK && serverEnv.STATIQ_API_TOKEN !== undefined) {
    // fail closed BEFORE spawning: a mock acceptance child must be
    // tokenless by construction (buildChildEnv is unit-tested; this is
    // the runtime belt-and-braces)
    console.error('[live-run] FAIL-CLOSED: mock child env unexpectedly carries a token');
    process.exit(2);
  }

  const server = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/server/src/index.ts'],
    { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let serverOut = '';
  let serverErr = '';
  server.stdout.on('data', (d) => {
    const s = String(d);
    serverOut += s;
    process.stdout.write(`[server] ${s}`);
  });
  server.stderr.on('data', (d) => {
    const s = String(d);
    serverErr += s;
    process.stderr.write(`[server] ${s}`);
  });

  /** Bounded wait for child exit (resolves even if the child hangs). */
  function waitExit(child, timeoutMs) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => resolve(), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Dual-safety persistence: the captured log is written SYNCHRONOUSLY
   * here - never only via a child 'exit' callback racing process.exit -
   * and again on the child exit listener if the child dies early. Both
   * paths are idempotent.
   */
  let logsPersisted = false;
  function persistLogs() {
    writeFileSync(serverLogPath, serverOut);
    writeFileSync(serverErrPath, serverErr);
  }

  async function stopServerAndPersistLogs(timeoutMs = 10_000) {
    server.kill();
    await waitExit(server, timeoutMs); // let the child flush its final output
    persistLogs();
    logsPersisted = true;
  }

  // fallback only: if the child dies on its own before the runner stops it
  server.on('exit', () => {
    if (!logsPersisted) {
      try {
        persistLogs();
      } catch {
        /* best effort */
      }
    }
  });

  // Signals: artifact durability + bounded child cleanup, then exit 130.
  // Registered inside main() so imported pure helpers carry no handlers.
  process.on('SIGINT', () => void signalShutdown('SIGINT'));
  process.on('SIGTERM', () => void signalShutdown('SIGTERM'));
  async function signalShutdown(signal) {
    try {
      await stopServerAndPersistLogs(3_000); // tighter bound: be snappy
      console.log(`[live-run] ${signal}; server log preserved at ${serverLogPath}`);
    } finally {
      process.exit(130);
    }
  }

  /** ONE request; explicit http status + wall time; no retries ever. The
   *  wall is DERIVED from the server's effective budget (see below) - the
   *  runner's parent env can diverge from the server's dotenv-merged
   *  config, so the server's OWN sanitized health budget is authoritative. */
  async function runOnce(wallMs) {
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
      signal: AbortSignal.timeout(wallMs),
    });
    const text = await res.text();
    return { httpStatus: res.status, ok: res.ok, text, ms: Date.now() - started };
  }

  function parsePlan(text) {
    try {
      const parsed = JSON.parse(text);
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
      return { parseError: 'response was not valid JSON', head: text.slice(0, 200) };
    }
  }

  let outcome;
  let health = null;
  // The wall actually used for the plan request - derived from the
  // server's reported effective budget after the health gate (see below)
  // and recorded into meta.json for auditability. Falls back to the
  // default wall when the health budget is absent.
  let wallMsUsed = fetchWallMs(undefined);
  try {
    // wait for health (bounded)
    const deadline = Date.now() + 30_000;
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
    if (!health) throw new RunnerFail('server-unhealthy', 'server did not become healthy within 30s');
    console.log(`[live-run] server healthy; mock=${health.mock} (expected ${MOCK})`);

    // MODE GATE: fail closed unless the server reports the expected mode
    if (health.mock !== MOCK) {
      throw new RunnerFail('mode-mismatch', `server mock=${health.mock}, runner expected mock=${MOCK}`);
    }

    // DERIVED FROM THE SERVER'S EFFECTIVE BUDGET (config-review repair):
    // /api/health reports the sanitized runBudget the server was actually
    // launched with (parent env AND dotenv merged) - while the runner's
    // own parent env can diverge from the server's dotenv config. The
    // request wall therefore comes from the server's OWN report; absent
    // or malformed there, fetchWallMs falls back to the previous default.
    wallMsUsed = fetchWallMs(health?.runBudget?.deadlineMs);
    console.log(
      `[live-run] fetch wall: ${wallMsUsed}ms (derived from the server's effective budget)`,
    );

    const result = await runOnce(wallMsUsed);
    writeFileSync(planPath, result.text || '(empty response body)');

    // SOURCE GATE: the plan's provenance must match the mode
    const expectedSource = MOCK ? 'synthetic' : 'live';
    const parsed = parsePlan(result.text);
    const sourceMatch = parsed.source === expectedSource;
    if (result.ok && parsed.source !== undefined && !sourceMatch) {
      outcome = {
        outcome: 'source-mismatch',
        httpStatus: result.httpStatus,
        ok: result.ok,
        parse: parsed,
        expectedSource,
        sourceMatch,
        ms: result.ms,
      };
    } else {
      outcome = {
        outcome: result.ok && (parsed.error || parsed.parseError) === undefined ? 'plan-ok' : 'plan-http-error',
        httpStatus: result.httpStatus,
        ok: result.ok,
        parse: parsed,
        expectedSource,
        sourceMatch,
        ms: result.ms,
      };
    }
  } catch (err) {
    if (err instanceof RunnerFail) {
      outcome = { outcome: err.outcome, error: `${err.name}: ${err.message}` };
    } else {
      outcome = {
        outcome: 'runner-error',
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
    // durability: the failure is retained as a labeled artifact, including
    // transport errors (fetch walls) - the outcome name travels with it
    try {
      writeFileSync(planPath, `(${outcome.outcome}: ${outcome.error})`);
    } catch {
      /* best effort */
    }
  } finally {
    // Durability: kill, await the child's exit (bounded) so its final
    // output flushes, THEN persist the captured log - before any RESULT
    // line or process.exit. Success, failure and signals all flow here.
    await stopServerAndPersistLogs(10_000);
  }
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        runDir: runDir,
        mode: MOCK ? 'mock' : 'live',
        fetchWallMs: wallMsUsed,
        health,
        ...outcome,
        files: { plan: 'plan.json', serverLog: 'server.log', serverErr: 'server-stderr.log' },
      },
      null,
      2,
    )}\n`,
  );

  const code = exitCodeFor(outcome);
  console.log(`[live-run] RESULT ${JSON.stringify(outcome)}`);
  console.log(`[live-run] artifacts: server.log -> ${serverLogPath}`);
  console.log(`[live-run] exit=${code} (0 only for plan-ok with matching provenance)`);
  process.exit(code);
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  void main();
}
