/**
 * Live acceptance runner integration (MOCK path only - never upstream).
 *
 * Proves the runner end-to-end against a real spawned mock server:
 *  - the run produces ALL durable artifacts (server.log with the startup
 *    line, plan.json, meta.json) - the historical defect lost server.log
 *    on the success path;
 *  - the plan gate passes only for synthetic provenance (source ===
 *    'synthetic'), and the process exit code matches exitCodeFor (0 only
 *    for plan-ok + matching provenance - the old runner always exited 0).
 *
 * Like every acceptance artifact, the run dir is retained as evidence
 * (never deleted by the test).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Dedicated port: a stale process must never answer instead of our child. */
const LIVE_PORT = '8891';

function listRunDirs(): string[] {
  return readdirSync(ROOT)
    .filter((n) => n.startsWith('.tmp-live-run-'))
    .sort();
}

describe('live acceptance runner (mock integration, fail-closed by construction)', () => {
  it(
    'a --mock run passes both gates, exits 0 and retains every artifact',
    async () => {
      const before = new Set(listRunDirs());
      const child = spawn(
        process.execPath,
        [join('scripts', 'live-acceptance.mjs'), '--mock'],
        { cwd: ROOT, env: { ...process.env, LIVE_PORT }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.stderr.on('data', (d) => {
        out += String(d);
      });

      // bounded wait: mock boot is seconds; the wall exists for CI variance
      let code: number | null = null;
      let signal: string | null = null;
      const exited = once(child, 'exit').then((r) => {
        code = (r as [number | null, string | null])[0];
        signal = (r as [number | null, string | null])[1];
        return true;
      });
      const timedOut = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 120_000).unref();
      });
      const becauseTimeout = (await Promise.race([exited.then(() => false), timedOut])) === true;
      if (becauseTimeout) {
        child.kill('SIGKILL');
        throw new Error(`runner did not exit in 120s; output so far:\n${out.slice(-2000)}`);
      }
      expect(signal ?? null).toBeNull(); // exited by itself

      // fail-closed exit status: 0 ONLY for plan-ok with matching provenance
      expect(code).toBe(0);

      // the run directory exists, is NEW, and is fully populated evidence
      const dirs = listRunDirs().filter((d) => !before.has(d));
      expect(dirs.length).toBeGreaterThanOrEqual(1);
      const runDir = join(ROOT, dirs[dirs.length - 1] as string);
      for (const f of ['server.log', 'server-stderr.log', 'plan.json', 'meta.json']) {
        expect(existsSync(join(runDir, f))).toBe(true);
      }

      // server.log: the startup line answers mock:true (coordinator checked
      // this manually before every click; now the suite enforces it)
      const serverLog = readFileSync(join(runDir, 'server.log'), 'utf8');
      expect(serverLog).toMatch(/mock:\s*true/i);

      // plan.json: the SOURCE gate artifact - synthetic, never live
      const planBody = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')) as {
        plan?: { source?: string };
        source?: string;
        error?: string;
      };
      expect(planBody.plan?.source ?? planBody.source).toBe('synthetic');

      // meta.json: outcome plan-ok with matching provenance, no secrets
      const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as {
        mode: string;
        outcome: string;
        sourceMatch: boolean;
        health?: { mock: boolean };
      };
      expect(meta.mode).toBe('mock');
      expect(meta.outcome).toBe('plan-ok');
      expect(meta.sourceMatch).toBe(true);
      expect(meta.health?.mock).toBe(true);
      const metaJson = JSON.stringify(meta);
      expect(metaJson).not.toContain('STATIQ_API_TOKEN');
      expect(metaJson).not.toContain('AI_API_KEY');
      // artifacts are evidence: the run dir stays in place, never deleted
    },
    180_000,
  );
});
