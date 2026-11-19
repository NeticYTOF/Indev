/**
 * Environment for the MCP server (mirrors apps/server/src/env.ts semantics).
 *
 * The MCP server shares the HTTP server's data dir, so saved trips are the
 * same records. The repo root is derived from this file's location, never
 * from cwd (MCP clients may spawn us from anywhere).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpEnv {
  statiqToken: string | undefined;
  dataDir: string;
  mock: boolean;
}

export function mcpRootDir(): string {
  // apps/mcp/src/env.ts -> repo root is three levels up
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function loadMcpEnv(): McpEnv {
  const root = mcpRootDir();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1] as string;
      const value = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
  return {
    statiqToken: process.env.STATIQ_API_TOKEN || undefined,
    dataDir: process.env.DATA_DIR || join(root, 'data'),
    mock: /^(1|true|yes)$/i.test(process.env.INDEV_MOCK ?? ''),
  };
}
