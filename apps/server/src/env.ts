/**
 * Environment loading (tiny, no deps).
 *
 * Loads .env from the repo root when present; real environment variables
 * ALWAYS win. The STATIQ_API_TOKEN is read but never logged.
 *
 * CONTAMINATION GUARANTEE (acceptance/live by construction): .env values
 * fill only keys that are MISSING from the environment - including keys
 * pinned to an EMPTY string. Explicit launcher values (INDEV_MOCK='0',
 * AI_*='') therefore cannot be overridden by the repo .env, so a live
 * acceptance run cannot have its mode flipped to mock or its AI planner
 * silently enabled by whatever the repo .env happens to contain.
 *
 * INDEV_SKIP_DOTENV=1 (set by the mock UI stacks) skips the .env file
 * entirely, so credential-free verification stacks never even load live
 * credentials into their environment.
 *
 * Hermetic by construction: nothing mutates process.env; the merged view is
 * local (loadEnv(root, source) computes over `source` - defaulting to
 * process.env - so fixture tests never touch the real environment).
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

/**
 * Load the server environment. `source` defaults to process.env; tests pass
 * an explicit record. .env (at `root`) fills only keys missing from
 * `source` - existing values (including empty strings) always win.
 */
export function loadEnv(
  root: string,
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const merged: Record<string, string | undefined> = { ...source };
  if (merged.INDEV_SKIP_DOTENV !== '1') {
    const envPath = join(root, '.env');
    if (existsSync(envPath)) {
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
  }
  return {
    port: Number(merged.PORT) || 8787,
    statiqToken: merged.STATIQ_API_TOKEN || undefined,
    dataDir: merged.DATA_DIR || join(root, 'data'),
    mock: /^(1|true|yes)$/i.test(merged.INDEV_MOCK ?? ''),
    aiBaseUrl: merged.AI_BASE_URL || undefined,
    aiApiKey: merged.AI_API_KEY || undefined,
    aiModel: merged.AI_MODEL || undefined,
  };
}

export function aiEnabled(env: ServerEnv): boolean {
  return Boolean(env.aiBaseUrl && env.aiApiKey && env.aiModel);
}
