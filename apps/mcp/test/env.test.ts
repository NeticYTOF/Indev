import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadMcpEnv } from '../src/env.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'indev-mcp-env-')); dirs.push(root);
  await writeFile(join(root, '.env'), 'STATIQ_API_TOKEN=fixture-only\nINDEV_MOCK=1\nDATA_DIR=fixture-data\n');
  return root;
}

it('honors dotenv skip without loading fixture credentials or mode', async () => {
  const root = await fixture();
  const source = { INDEV_SKIP_DOTENV: '1', INDEV_MOCK: '0' };
  expect(loadMcpEnv(root, source)).toEqual({ statiqToken: undefined, mock: false, dataDir: join(root, 'data') });
  expect(source).toEqual({ INDEV_SKIP_DOTENV: '1', INDEV_MOCK: '0' });
});

it('keeps normal dev dotenv defaults without mutating its source', async () => {
  const root = await fixture();
  const source = {};
  expect(loadMcpEnv(root, source)).toEqual({ statiqToken: 'fixture-only', mock: true, dataDir: 'fixture-data' });
  expect(source).toEqual({});
});

it('preserves explicit launch values over dotenv defaults', async () => {
  const root = await fixture();
  expect(loadMcpEnv(root, { STATIQ_API_TOKEN: '', INDEV_MOCK: '0', DATA_DIR: 'chosen-data' }))
    .toEqual({ statiqToken: undefined, mock: false, dataDir: 'chosen-data' });
});
