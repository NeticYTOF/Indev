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
  /**
   * EXPLICIT per-launch planning-budget overrides (operator-supplied, e.g.
   * for a coordinated acceptance). ABSENT = undefined = the defaults are
   * byte-identical to before; PRESENT but malformed = LOUD failure at boot.
   * Never silently clamped.
   */
  planMaxCalls: number | undefined;
  planDeadlineMs: number | undefined;
  planRetries: number | undefined;
  /**
   * Per-launch instance identity (INDEV_LAUNCH_ID): a random UUID the
   * LAUNCHER (e.g. the acceptance runner) generates per launch and the
   * server echoes in /api/health - NOT a credential, never validated. It
   * lets a launcher prove the health answer came from ITS OWN child and
   * not an unrelated same-mode server that happens to hold the port
   * (the proven empty-log success race). Absent = undefined (plain `npm
   * run dev` launches need no identity).
   */
  launchId: string | undefined;
}

/**
 * Strictly validate an explicit integer override: absent -> undefined;
 * present must be an integer within [min, max] or the boot FAILS LOUDLY.
 * (No silent clamping: a fat-fingered override must never quietly
 * reshape a run's budget.)
 */
function parseIntOverride(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
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
    // Explicit bounded overrides; absent = defaults, malformed = loud boot failure
    planMaxCalls: parseIntOverride('INDEV_PLAN_MAX_CALLS', merged.INDEV_PLAN_MAX_CALLS, 1, 10_000),
    planDeadlineMs: parseIntOverride('INDEV_PLAN_DEADLINE_MS', merged.INDEV_PLAN_DEADLINE_MS, 10_000, 6 * 60 * 60_000),
    planRetries: parseIntOverride('INDEV_PLAN_RETRIES', merged.INDEV_PLAN_RETRIES, 0, 3),
    // Per-launch instance identity: plain passthrough (a launcher-generated
    // UUID; never a credential, no validation semantics)
    launchId: merged.INDEV_LAUNCH_ID || undefined,
  };
}

export function aiEnabled(env: ServerEnv): boolean {
  return Boolean(env.aiBaseUrl && env.aiApiKey && env.aiModel);
}
