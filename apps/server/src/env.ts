/**
 * Environment loading (tiny, no deps).
 *
 * Loads .env from the repo root when present; real environment variables
 * always win. The STATIQ_API_TOKEN is read but never logged.
 *
 * INDEV_SKIP_DOTENV=1 (set by the mock UI stacks) skips the .env file
 * entirely, so credential-free verification stacks never even load live
 * credentials into their process env.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerEnv {
  port: number;
  statiqToken: string | undefined;
  dataDir: string;
  /** Mock mode: synthetic plans/stations for UI dev, no live upstream calls. */
  mock: boolean;
  aiBaseUrl: string | undefined;
  aiApiKey: string | undefined;
  aiModel: string | undefined;
}

export function loadEnv(root: string): ServerEnv {
  if (process.env.INDEV_SKIP_DOTENV !== '1') {
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
  }
  return {
    port: Number(process.env.PORT) || 8787,
    statiqToken: process.env.STATIQ_API_TOKEN || undefined,
    dataDir: process.env.DATA_DIR || join(root, 'data'),
    mock: /^(1|true|yes)$/i.test(process.env.INDEV_MOCK ?? ''),
    aiBaseUrl: process.env.AI_BASE_URL || undefined,
    aiApiKey: process.env.AI_API_KEY || undefined,
    aiModel: process.env.AI_MODEL || undefined,
  };
}

export function aiEnabled(env: ServerEnv): boolean {
  return Boolean(env.aiBaseUrl && env.aiApiKey && env.aiModel);
}
