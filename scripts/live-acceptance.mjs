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
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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
 * Durable, sanitized transport failure: the cause is CAPTURED (phase +
 * code + both elapsed clocks), never lost in a generic catch. Fields are
 * sanitized by construction: endpoint phase, a short code, timings and a
 * message - never a token, header, body or route data.
 */
export class PlanRequestError extends Error {
  constructor(phase, code, message, wallElapsedMs, monotonicElapsedMs) {
    super(
      `plan request failed at ${phase} (${code}) after ` +
        `${Math.round(wallElapsedMs)}ms wall / ${Math.round(monotonicElapsedMs)}ms monotonic: ${message}`,
    );
    this.name = 'PlanRequestError';
    this.phase = phase;
    this.code = code;
    this.wallElapsedMs = Math.round(wallElapsedMs);
    this.monotonicElapsedMs = Math.round(monotonicElapsedMs);
  }
}

/**
 * The runner's plan request: an EXPLICIT bounded local transport over
 * node:http. The configured wall (derived from the server's EFFECTIVE
 * health budget + slack, see fetchWallMs) is the ONLY deadline.
 *
 * Why not fetch: Node's bundled undici applies DEFAULT headers/body
 * timeouts (300s on the 6.29-series) INDEPENDENT of any AbortSignal - a
 * coordinated wall beyond 300s would be silently truncated at 5 minutes
 * (the probable cause of the observed 5-min active failure; the old catch
 * lost the cause, so never provable from its artifacts). node:http client
 * requests carry no such hidden defaults: the wall below is the only
 * bound. On failure the error carries BOTH elapsed clocks - wall and
 * monotonic - so a runtime suspension (wall >> monotonic) is never
 * mislabeled as provider latency.
 */
export function planRequest(port, wallMs, body) {
  return new Promise((resolve, reject) => {
    const wallStart = Date.now();
    const monoStart = performance.now();
    const fail = (phase, code, message) => {
      clearTimeout(deadlineTimer);
      reject(
        new PlanRequestError(phase, code, message, Date.now() - wallStart, performance.now() - monoStart),
      );
    };
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/api/plan',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        agent: false, // one-shot runner request: no keep-alive, no hidden defaults
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => fail('body', err.code ?? 'BODY_ERROR', err.message));
        res.on('aborted', () => fail('body', 'RESPONSE_ABORTED', 'response aborted mid-body'));
        res.on('end', () => {
          clearTimeout(deadlineTimer);
          resolve({
            httpStatus: status,
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - wallStart,
            monotonicMs: performance.now() - monoStart,
          });
        });
      },
    );
    // THE configured wall is the only bound: a local timer destroys the
    // request with a labeled cause (durable, never lost)
    const deadlineTimer = setTimeout(() => {
      const err = new Error(`runner wall (${wallMs}ms) exceeded`);
      err.code = 'RUNNER_WALL';
      req.destroy(err);
    }, wallMs);
    req.on('error', (err) => {
      const phase = err && err.code === 'RUNNER_WALL' ? 'deadline' : 'connect';
      fail(phase, err?.code ?? 'REQUEST_ERROR', err?.message ?? 'request failed');
    });
    req.end(body);
  });
}

/**
 * Bounded STREAM-COMPLETE teardown wait for a spawned child (exported for
 * the delayed-drain regression). The child's 'close' event is Node's
 * canonical "process ended AND all stdio handles closed" signal - it fires
 * only after EVERY data event of both streams has been delivered. The
 * 'exit' event carries NO such guarantee: Node documents no ordering
 * between 'exit' and stdio data delivery (the SIGCHLD reap path and the
 * pipe-drain path are independent), so persisting at 'exit' could -
 * intermittently and exactly as Linux's success-run empty server.log
 * showed - write before the drained output arrived. Bounded: a teardown
 * that never completes (hung handles) resolves via the timer with whatever
 * has drained - the honest degraded persistence, never an indefinite hang.
 */
export function waitChildClose(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, timeoutMs);
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // Fast path: the child already wound down fully (exit state set AND
    // both streams drained to end) - the 'close' event has already fired
    // and a fresh listener would hang until the timer; settle now. If the
    // exit state is set but the streams have NOT drained, the canonical
    // 'close' below resolves exactly when the late delivery completes.
    const stdoutDrained = !child.stdout || child.stdout.readableEnded || child.stdout.destroyed;
    const stderrDrained = !child.stderr || child.stderr.readableEnded || child.stderr.destroyed;
    if (
      (child.exitCode !== null || child.signalCode !== null) &&
      stdoutDrained &&
      stderrDrained
    ) {
      return settle();
    }
    child.once('close', settle);
  });
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
 *
 *  The PER-LAUNCH INSTANCE ID (INDEV_LAUNCH_ID) is ALWAYS stripped from
 *  the parent - it is a per-launch identity assigned fresh by the runner
 *  AFTER this function, so a stale parent id can never label the child.
 */
export function buildChildEnv(mode, parentEnv) {
  const env = { ...parentEnv };
  delete env.INDEV_LAUNCH_ID; // per-launch identity: assigned fresh below
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
  // INSTANCE PROVENANCE: a fresh per-run identity. The child echoes it in
  // /api/health; anything else answering the port (a stale process or an
  // unrelated same-mode server from a parallel suite - the PROVEN cause of
  // the recurring empty-log success) fails the gate below.
  const LAUNCH_ID = randomUUID();

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
    // THIS launch's identity (buildChildEnv already stripped any inherited
    // id): the child echoes it back in /api/health for the gate below
    INDEV_LAUNCH_ID: LAUNCH_ID,
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

  /**
   * Dual-safety persistence: the captured log is written SYNCHRONOUSLY
   * here - after the child's 'close' event (process ended AND all stdio
   * drained), never at the bare 'exit' - and again on the child 'close'
   * listener if the child dies early. Both paths are idempotent.
   */
  let logsPersisted = false;
  function persistLogs() {
    writeFileSync(serverLogPath, serverOut);
    writeFileSync(serverErrPath, serverErr);
  }

  async function stopServerAndPersistLogs(timeoutMs = 10_000) {
    server.kill();
    // STREAM-COMPLETE drain: 'close' fires only after exit AND full stdio
    // delivery - the persisted server.log can no longer race the pipe
    // backlog (the intermittent EMPTY log on success runs).
    await waitChildClose(server, timeoutMs);
    persistLogs();
    logsPersisted = true;
  }

  // fallback only: if the child dies on its own before the runner stops it;
  // 'close' (not 'exit') so even this best-effort path waits for the drain
  server.on('close', () => {
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

  /** ONE request; explicit http status + BOTH elapsed clocks; no retries
   *  ever. The wall is DERIVED from the server's effective health budget
   *  (above) - the server's parent env can diverge from its dotenv-merged
   *  config, so the server's OWN sanitized health budget is authoritative.
   *  The request goes through planRequest (node:http): the configured wall
   *  is the ONLY deadline - undici's default fetch headers/body timeouts
   *  (300s) can no longer silently truncate a long coordinated wall. */
  async function runOnce(wallMs) {
    const body = JSON.stringify({
      origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
      destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
      startSocPct: 100,
    });
    const { httpStatus, ok, text, ms, monotonicMs } = await planRequest(PORT, wallMs, body);
    return { httpStatus, ok, text, ms, monotonicMs };
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

    // INSTANCE GATE (the provenance race killer): the health answer must
    // come from THIS launch's own child (the id it echoes must equal the
    // id this run assigned). An unrelated SAME-MODE server that happens
    // to hold the port - the proven cause of the recurring empty-log
    // success - fails here, BEFORE any wall derivation and BEFORE any plan
    // request. No fallback tolerance: a missing id is a foreign server.
    if (health.launchId !== LAUNCH_ID) {
      throw new RunnerFail(
        'instance-mismatch',
        `health.launchId=${JSON.stringify(health.launchId ?? null)} does not identify this launch's server`,
      );
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
        monotonicMs: result.monotonicMs,
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
        monotonicMs: result.monotonicMs,
      };
    }
  } catch (err) {
    if (err instanceof RunnerFail) {
      outcome = { outcome: err.outcome, error: `${err.name}: ${err.message}` };
    } else if (err instanceof PlanRequestError) {
      // DURABLE SANITIZED TRANSPORT CAUSE (the old catch lost it): phase +
      // code + BOTH clocks travel with the outcome, so a runner wall hit
      // or a socket failure is never a generic 'runner-error' again, and a
      // runtime suspension (wall >> monotonic) is not mislabeled as
      // provider latency
      outcome = {
        outcome: 'runner-error',
        error: err.message,
        transport: {
          phase: err.phase,
          code: err.code,
          wallElapsedMs: err.wallElapsedMs,
          monotonicElapsedMs: err.monotonicElapsedMs,
        },
      };
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
