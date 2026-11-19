/**
 * Live acceptance runner integration (MOCK path only - never upstream).
 *
 * End-to-end proofs against real spawned children:
 *  1. happy path: a --mock run passes the mode and INSTANCE gates (health
 *     mock:true + THIS launch's id, plan source synthetic), exits 0 per
 *     exitCodeFor, and retains every artifact in its unique run dir
 *     (server.log with the startup line, plan.json, meta.json) - the
 *     historical defect lost server.log on the success path, and the old
 *     runner always exited 0.
 *  2. MODE GATE (fail-closed): a NON-mock server answering health on the
 *     runner's port must fail the --mock run: exit non-zero, outcome
 *     mode-mismatch, failure retained as a labeled artifact. A live-mode
 *     server can never serve the mock acceptance path quietly.
 *  3. INSTANCE GATE (fail-closed, the proven race): a SAME-MODE server
 *     from ANOTHER launch answering health on the runner's port must fail
 *     the run BEFORE any plan request - exit non-zero, outcome
 *     instance-mismatch, and ZERO /api/plan hits on the impostor. This is
 *     the proven cause of the recurring empty-log success (two parallel
 *     suites shared fixed port 8891); it must never be possible again.
 *
 * Every test uses a DYNAMIC ephemeral port (allocate, release, spawn) so
 * parallel suites can never share a fixed test port.
 *
 * Like every acceptance artifact, run dirs are retained as evidence
 * (never deleted by the test).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A free ephemeral port (listen(0) then close): no fixed test port can
 *  collide with a parallel suite (the proven 8891 sharing). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function listRunDirs(): string[] {
  return readdirSync(ROOT)
    .filter((n) => n.startsWith('.tmp-live-run-'))
    .sort();
}

/** Spawn the runner and wait (bounded) for its own exit. */
async function runRunner(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [join('scripts', 'live-acceptance.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += String(d);
  });
  child.stderr.on('data', (d) => {
    out += String(d);
  });
  const [code, signal] = (await Promise.race([
    once(child, 'exit') as Promise<[number | null, string | null]>,
    new Promise<[number | null, string | null]>((r) => {
      setTimeout(() => r([null, 'test-timeout']), 120_000).unref();
    }),
  ])) as [number | null, string | null];
  return { child, out, code, signal };
}

/** Newest run dir created since `before`; artifacts are evidence, kept. */
function newestRunDir(since: Set<string>): string {
  const dirs = listRunDirs().filter((d) => !since.has(d));
  expect(dirs.length).toBeGreaterThanOrEqual(1);
  return join(ROOT, dirs[dirs.length - 1] as string);
}

describe('live acceptance runner (mock integration, fail-closed by construction)', () => {
  it(
    'a --mock run passes both gates, exits 0 and retains every artifact',
    async () => {
      const before = new Set(listRunDirs());
      const MOCK_RUN_PORT = String(await freePort());
      const { code, signal } = await runRunner(['--mock'], { LIVE_PORT: MOCK_RUN_PORT });
      expect(signal ?? null).toBeNull(); // exited by itself

      // fail-closed exit status: 0 ONLY for plan-ok + matching provenance
      expect(code).toBe(0);

      const runDir = newestRunDir(before);
      for (const f of ['server.log', 'server-stderr.log', 'plan.json', 'meta.json']) {
        expect(existsSync(join(runDir, f))).toBe(true);
      }

      // server.log: the startup line answers mock:true (the coordinator
      // checked this manually before every click; the suite enforces it)
      const serverLog = readFileSync(join(runDir, 'server.log'), 'utf8');
      expect(serverLog).toMatch(/mock:\s*true/i);

      // plan.json: the SOURCE gate artifact - synthetic, never live
      const planBody = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')) as {
        plan?: { source?: string };
        source?: string;
      };
      expect(planBody.plan?.source ?? planBody.source).toBe('synthetic');

      // meta.json: outcome plan-ok with matching provenance, no secrets
      const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as {
        mode: string;
        outcome: string;
        sourceMatch: boolean;
        fetchWallMs?: number;
        health?: { mock: boolean; launchId?: string | null; runBudget?: { deadlineMs?: number } };
      };
      expect(meta.mode).toBe('mock');
      expect(meta.outcome).toBe('plan-ok');
      expect(meta.sourceMatch).toBe(true);
      expect(meta.health?.mock).toBe(true);
      // WALL DERIVATION (config-review repair, spawned-process regression):
      // the request wall comes from the server's OWN reported effective
      // budget - NOT the runner's parent env, which can diverge from the
      // server's dotenv-merged config. Env-independent contract:
      // wall == server-reported deadline + 30s slack.
      expect(meta.health?.runBudget).toBeDefined();
      expect(meta.health?.runBudget?.deadlineMs).toBeGreaterThan(0);
      expect(meta.fetchWallMs).toBe((meta.health?.runBudget?.deadlineMs ?? 0) + 30_000);
      const metaJson = JSON.stringify(meta);
      expect(metaJson).not.toContain('STATIQ_API_TOKEN');
      expect(metaJson).not.toContain('AI_API_KEY');
      // INSTANCE GATE end-to-end: the health answer carried THIS launch's
      // id (the runner assigned a fresh INDEV_LAUNCH_ID; its own child
      // echoed it) - the gate passed on the runner's OWN server instance
      expect(meta.health?.launchId).toEqual(expect.any(String));
      expect(meta.health?.launchId).not.toBe('');
      // artifacts are evidence: the run dir stays in place, never deleted
    },
    180_000,
  );

  it(
    'MODE GATE: a non-mock server on the port fails the --mock run closed',
    async () => {
      // Pose as a LIVE-mode server: health answers mock:false. The runner
      // must detect the mismatch before any plan request, exit non-zero
      // and retain the labeled failure artifact.
      let sawHealth = false;
      let sawPlanRequest = false;
      const impostor: Server = createServer((req, res) => {
        if (String(req.url).includes('/api/health')) {
          sawHealth = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mock: false, chargersSeen: 0, ai: false }));
          return;
        }
        if (String(req.url).includes('/api/plan')) {
          sawPlanRequest = true;
        }
        res.writeHead(404);
        res.end();
      });
      const MODE_GATE_PORT = String(await freePort());
      await new Promise<void>((r) => impostor.listen(Number(MODE_GATE_PORT), 'localhost', () => r()));

      let child: ChildProcess | null = null;
      try {
        const before = new Set(listRunDirs());
        const result = await runRunner(['--mock'], { LIVE_PORT: MODE_GATE_PORT });
        child = result.child;
        const { code, signal, out } = result;
        expect(signal ?? null).toBeNull();
        expect(sawHealth).toBe(true); // the impostor served the health poll

        // fail-closed: NOT exit 0 - a live server can never pass the mock
        // acceptance path, and the mismatch is explicit in the output
        expect(code).not.toBe(0);
        expect(out).toContain('mode-mismatch');
        // rejection BEFORE any plan request: the impostor never saw one
        expect(sawPlanRequest).toBe(false);

        // labeled failure artifact + meta evidence, retained in a new dir
        const runDir = newestRunDir(before);
        const planText = readFileSync(join(runDir, 'plan.json'), 'utf8');
        expect(planText).toContain('mode-mismatch');
        const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as {
          outcome: string;
          health?: { mock: boolean };
        };
        expect(meta.outcome).toBe('mode-mismatch');
        expect(meta.health?.mock).toBe(false);
        expect(existsSync(join(runDir, 'server.log'))).toBe(true);
        expect(existsSync(join(runDir, 'server-stderr.log'))).toBe(true);
      } finally {
        impostor.close();
        child?.kill();
      }
    },
    180_000,
  );

  it(
    'INSTANCE GATE: an unrelated SAME-MODE server on the port fails the run closed BEFORE any plan request',
    async () => {
      // THE PROVEN PROVENANCE RACE, made deterministic: a foreign mock-mode
      // server (another launch's instance, exactly what a parallel suite
      // on a shared fixed port looked like) answers health with mock:true
      // AND ITS OWN launch id. The mode gate alone would PASS - only the
      // INSTANCE gate can catch it. The runner must reject as
      // instance-mismatch BEFORE deriving the wall or sending any plan
      // request: the impostor's request log must show health polls and
      // ZERO /api/plan hits.
      let sawHealth = false;
      let planRequests = 0;
      const impostor: Server = createServer((req, res) => {
        if (String(req.url).includes('/api/health')) {
          sawHealth = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // SAME MODE as the runner expects - only the IDENTITY differs
          res.end(
            JSON.stringify({
              ok: true,
              mock: true,
              chargersSeen: 0,
              ai: false,
              // another launch's child: it echoes ITS OWN id, not ours
              launchId: 'some-other-launch-uuid',
              runBudget: {
                maxUpstreamCalls: 200,
                deadlineMs: 4 * 60_000,
                retries: 2,
              },
            }),
          );
          return;
        }
        if (String(req.method) === 'POST' && String(req.url).includes('/api/plan')) {
          planRequests++;
        }
        res.writeHead(404);
        res.end();
      });
      const INSTANCE_GATE_PORT = String(await freePort());
      await new Promise<void>((r) => impostor.listen(Number(INSTANCE_GATE_PORT), 'localhost', () => r()));

      let child: ChildProcess | null = null;
      try {
        const before = new Set(listRunDirs());
        const result = await runRunner(['--mock'], { LIVE_PORT: INSTANCE_GATE_PORT });
        child = result.child;
        const { code, signal, out } = result;
        expect(signal ?? null).toBeNull();
        expect(sawHealth).toBe(true); // the impostor served the health polls

        // fail-closed: NOT exit 0 despite the SAME MODE - only identity
        // differs, and the mismatch is explicit in the output
        expect(code).not.toBe(0);
        expect(out).toContain('instance-mismatch');

        // REJECTION BEFORE THE PLAN REQUEST: the impostor never saw one
        expect(planRequests).toBe(0);

        // labeled failure artifact + meta evidence, retained in a new dir
        const runDir = newestRunDir(before);
        const planText = readFileSync(join(runDir, 'plan.json'), 'utf8');
        expect(planText).toContain('instance-mismatch');
        const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as {
          outcome: string;
          health?: { mock: boolean; launchId?: string | null };
        };
        expect(meta.outcome).toBe('instance-mismatch');
        expect(meta.health?.mock).toBe(true); // the run really was same-mode
        expect(meta.health?.launchId).toBe('some-other-launch-uuid');
        expect(existsSync(join(runDir, 'server.log'))).toBe(true);
        expect(existsSync(join(runDir, 'server-stderr.log'))).toBe(true);
      } finally {
        impostor.close();
        child?.kill();
      }
    },
    180_000,
  );
});
