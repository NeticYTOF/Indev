import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  args: [] as Array<{ checkedIdHistory?: { load: (scope: string) => Promise<unknown> } }>,
  env: {} as Record<string, unknown>,
}));

vi.mock('../src/env.js', () => ({ loadEnv: () => h.env, aiEnabled: () => false }));
vi.mock('../src/app.js', () => ({ createApp: (deps: unknown) => {
  h.args.push(deps as typeof h.args[number]);
  return { fetch: async () => new Response('ok') };
} }));
vi.mock('../src/statiq-factory.js', () => ({ buildStatiqFactory: () => () => ({}) }));
vi.mock('@hono/node-server', () => ({ serve: () => ({ close: () => {} }) }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function bootstrap(mock: boolean) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), 'indev-bootstrap-'));
  dirs.push(dataDir);
  h.args.length = 0;
  h.env = { port: 8799, dataDir, mock, statiqToken: 'fixture-token',
    planMaxCalls: 200, planDeadlineMs: 240_000 };
  const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Dynamic import is required: each case re-executes index.ts with a fresh mocked env.
  await import('../src/index.js');
  onSpy.mockRestore();
  logSpy.mockRestore();
  expect(h.args).toHaveLength(1);
  const store = h.args[0]!.checkedIdHistory;
  expect(store).toBeDefined();
  await store!.load('a'.repeat(64));
  return { dataDir, store };
}

describe('actual index.ts bootstrap wiring', () => {
  it.each([false, true])('passes the real checked-ID store with mode-separated file (mock=%s)',
    async (mock) => {
      const { dataDir } = await bootstrap(mock);
      const suffix = mock ? '.mock' : '';
      const info = await stat(join(dataDir, `checked-id-history${suffix}.json`));
      expect(info.isFile()).toBe(true);
    });
});
