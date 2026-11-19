import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('advertises custom claimed range in km on the real mock-gated MCP schema', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'indev-mcp-schema-'));
  const env = { ...process.env, INDEV_MOCK: '1', INDEV_SKIP_DOTENV: '1', DATA_DIR: dir };
  for (const key of ['STATIQ_API_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL']) delete (env as Record<string, string | undefined>)[key];
  const client = new Client({ name: 'local-schema-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'apps/mcp/src/index.ts')], cwd: dir, env: env as Record<string, string>, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const plan = tools.find(tool => tool.name === 'plan_trip')!;
    const properties = (plan.inputSchema.properties!.customVehicle as { properties: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty('claimedRangeKm');
    expect(properties).not.toHaveProperty('claimedRangeKwh');
  } finally {
    await client.close();
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  }
});
