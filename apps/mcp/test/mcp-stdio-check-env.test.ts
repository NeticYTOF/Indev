import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadMcpEnv } from '../src/env.js';
import { mockStdioCheckEnv } from '../../../scripts/mcp-stdio-check.mjs';

it('mock stdio check strips parent credentials and ignores fixture dotenv', () => {
  const root = mkdtempSync(join(tmpdir(), 'indev-mcp-check-env-'));
  try {
    writeFileSync(join(root, '.env'), [
      'STATIQ_API_TOKEN=fixture-token',
      'AI_BASE_URL=https://fixture.invalid/v1',
      'AI_API_KEY=fixture-key',
      'AI_MODEL=fixture-model',
      'INDEV_MOCK=0',
      '',
    ].join('\n'));

    const contaminatedParent = {
      PATH: process.env.PATH ?? '',
      INDEV_MOCK: '0',
      STATIQ_API_TOKEN: 'parent-token',
      AI_BASE_URL: 'https://parent.invalid/v1',
      AI_API_KEY: 'parent-key',
      AI_MODEL: 'parent-model',
    };
    const childEnv = mockStdioCheckEnv(contaminatedParent, root);

    expect(childEnv).toMatchObject({
      INDEV_MOCK: '1',
      INDEV_SKIP_DOTENV: '1',
      DATA_DIR: join(root, '.tmp-mcp-check'),
    });
    for (const key of ['STATIQ_API_TOKEN', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) {
      expect(key in childEnv).toBe(false);
    }

    const resolved = loadMcpEnv(root, childEnv);
    expect(resolved.mock).toBe(true);
    expect(resolved.statiqToken).toBeUndefined();
    expect(resolved.dataDir).toBe(join(root, '.tmp-mcp-check'));
    expect(JSON.stringify(childEnv)).not.toContain('parent-token');
    expect(JSON.stringify(childEnv)).not.toContain('fixture-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
