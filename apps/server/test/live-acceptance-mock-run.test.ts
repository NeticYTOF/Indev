/**
 * Live acceptance runner integration (MOCK path only - never upstream).
 *
 * End-to-end proofs against real spawned children:
 *  1. happy path: a --mock run passes both gates (health mock:true, plan
 *     source synthetic), exits 0 per exitCodeFor, and retains every
 *     artifact in its unique run dir (server.log with the startup line,
 *     plan.json, meta.json) - the historical defect lost server.log on
 *     the success path, and the old runner always exited 0.
 *  2. MODE GATE (fail-closed): a non-mock server answering health on the
 *     runner's port must fail the --mock run: exit non-zero, outcome
 *     mode-mismatch, failure retained as a labeled artifact. A live-mode
 *     server can never serve the mock acceptance path quietly.
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
/** Dedicated ports: a stale process must never answer instead of our child. */
const MOCK_RUN_PORT = '8891';
const MODE_GATE_PORT = '8892';

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
        health?: { mock: boolean; runBudget?: { deadlineMs?: number } };
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
      const impostor: Server = createServer((req, res) => {
        if (String(req.url).includes('/api/health')) {
          sawHealth = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mock: false, chargersSeen: 0, ai: false }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
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
});
