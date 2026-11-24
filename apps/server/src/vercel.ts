/**
 * Serverless entry for the hosted (Vercel) deployment.
 *
 * Differences from index.ts, all deliberate:
 * - no listening socket: Vercel calls the exported Node request listener;
 * - `hosted: true`: no process-local jobs (an instance may freeze or vanish
 *   between requests), no server-side saved trips (the web app keeps them
 *   on the device), and the request's own https host counts as same-origin;
 * - writable state lives in the instance's /tmp, so the advisory charger
 *   counter and checked-ID history are per-instance and best-effort.
 *
 * The Statiq token comes only from the Vercel project environment.
 */
import { getRequestListener } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckedIdHistoryStore, CountersStore, OsrmRouter, PhotonGeocoder, TripsStore,
  type UpstreamAuditEntry,
} from '@indeev/core';
import { aiEnabled, loadEnv } from './env.js';
import { createApp, SERVER_RUN_BUDGET } from './app.js';
import { buildStatiqFactory } from './statiq-factory.js';

const env = loadEnv(process.cwd(), { ...process.env, INDEV_SKIP_DOTENV: '1' });
if (!env.mock && !env.statiqToken) {
  throw new Error('STATIQ_API_TOKEN is not set in the Vercel project environment.');
}

const dataDir = join(tmpdir(), 'indeev');
mkdirSync(dataDir, { recursive: true });
const suffix = env.mock ? '.mock' : '';

const runBudget = {
  maxUpstreamCalls: env.planMaxCalls ?? SERVER_RUN_BUDGET.maxUpstreamCalls,
  deadlineMs: env.planDeadlineMs ?? SERVER_RUN_BUDGET.deadlineMs,
};

const app = createApp({
  hosted: true,
  mock: env.mock,
  // Unreachable when hosted (trip routes answer before touching it).
  trips: new TripsStore({ filePath: join(dataDir, `saved-trips${suffix}.json`) }),
  counters: new CountersStore({ filePath: join(dataDir, `counters${suffix}.json`) }),
  checkedIdHistory: new CheckedIdHistoryStore({ filePath: join(dataDir, `checked-id-history${suffix}.json`) }),
  router: new OsrmRouter(),
  geocoder: new PhotonGeocoder(),
  planRunBudget: runBudget,
  ...(env.planRetries !== undefined ? { statiqRetries: env.planRetries } : {}),
  selectiveProfile: env.selectiveProfile,
  allowedWebOrigins: [],
  createStatiq: buildStatiqFactory({
    token: env.statiqToken as string,
    deadlineMs: runBudget.deadlineMs,
    onUpstreamCall: (entry: UpstreamAuditEntry) => {
      console.log(JSON.stringify({ type: 'upstream', ...entry }));
    },
  }),
  onRunComplete: (outcome, upstreamCalls, providerFailures) => {
    console.log(JSON.stringify({ type: 'plan-run', outcome, upstreamCalls, providerFailures }));
  },
  ...(aiEnabled(env)
    ? { ai: { baseUrl: env.aiBaseUrl as string, apiKey: env.aiApiKey as string, model: env.aiModel as string } }
    : {}),
});

export default getRequestListener(app.fetch);
