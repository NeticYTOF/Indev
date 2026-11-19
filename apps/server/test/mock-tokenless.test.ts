/**
 * Finding (2): the mock server must boot and pass its gates with
 * STATIQ_API_TOKEN absent from env - tokenless, and with no substitute
 * credential. Spawned from a temp cwd (no .env there), sanitized env.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function sanitizedEnvWithoutCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.STATIQ_API_TOKEN;
  delete env.AI_BASE_URL;
  delete env.AI_API_KEY;
  delete env.AI_MODEL;
  return env;
}

const PORT = 8895;

describe('mock server boots tokenless', () => {
  it(
    'starts, serves mock health and synthetic plans with no credential in env',
    { timeout: 60_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'indeev-tokenless-'));
      tempDirs.push(dir);

      // spawned from a temp cwd: no .env file exists there, so the server
      // cannot load any token from disk either
      const child = spawn(
        process.execPath,
        [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'apps/server/src/index.ts')],
        {
          cwd: dir,
          env: {
            ...sanitizedEnvWithoutCredentials(),
            INDEV_MOCK: '1',
            INDEV_SKIP_DOTENV: '1',
            PORT: String(PORT),
            DATA_DIR: join(dir, 'data'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let out = '';
      let errOut = '';
      child.stdout!.on('data', (d) => {
        out += String(d);
      });
      child.stderr!.on('data', (d) => {
        errOut += String(d);
      });

      // the startup line must say mock: true - read it, never assume it
      const started = await new Promise<boolean>((resolveStarted) => {
        const timer = setTimeout(() => {
          clearInterval(check);
          resolveStarted(false);
        }, 30_000);
        const check = setInterval(() => {
          if (out.includes('mock: true')) {
            clearInterval(check);
            clearTimeout(timer);
            resolveStarted(true);
          }
          if (out.includes('mock: false') || errOut.includes('STATIQ_API_TOKEN is missing')) {
            clearInterval(check);
            clearTimeout(timer);
            resolveStarted(false);
          }
        }, 300);
        child.on('exit', (code) => {
          clearInterval(check);
          clearTimeout(timer);
          resolveStarted(code === 0);
        });
      });
      expect(
        started,
        `boot output: ${out.slice(0, 300)} stderr: ${errOut.slice(0, 300)}`,
      ).toBe(true);
      expect(errOut).not.toContain('STATIQ_API_TOKEN is missing');

      // gates: health mock:true and a synthetic plan (no live call possible)
      const health = (await (
        await fetch(`http://localhost:${PORT}/api/health`)
      ).json()) as { mock: boolean; ai: boolean };
      expect(health.mock).toBe(true);
      expect(health.ai).toBe(false); // AI config stripped too

      const planRes = await fetch(`http://localhost:${PORT}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
          destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
        }),
      });
      const plan = (await planRes.json()) as { plan: { source: string } };
      expect(plan.plan.source).toBe('synthetic');
    },
  );
});
