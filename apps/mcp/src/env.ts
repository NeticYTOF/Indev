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

export function loadMcpEnv(
  root = mcpRootDir(),
  source: NodeJS.ProcessEnv = process.env,
): McpEnv {
  const merged = { ...source };
  const envPath = join(root, '.env');
  if (merged.INDEV_SKIP_DOTENV !== '1' && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1] as string;
      const value = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return {
    statiqToken: merged.STATIQ_API_TOKEN || undefined,
    dataDir: merged.DATA_DIR || join(root, 'data'),
    mock: /^(1|true|yes)$/i.test(merged.INDEV_MOCK ?? ''),
  };
}
