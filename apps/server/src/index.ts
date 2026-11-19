import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, TripsStore } from '@indeev/core';
import { aiEnabled, loadEnv } from './env.js';
import { createApp, SERVER_RUN_BUDGET } from './app.js';
import type { UpstreamAuditEntry } from '@indeev/core';

const root = process.cwd();
const env = loadEnv(root);

if (!env.mock && !env.statiqToken) {
  console.error(
    'STATIQ_API_TOKEN is missing. Add it to .env (see .env.example), or run in mock mode with INDEV_MOCK=1.',
  );
  process.exit(1);
}

mkdirSync(env.dataDir, { recursive: true });
// PROVENANCE ISOLATION: mock mode uses separate store files so synthetic
// records can never mix with (or clobber) the real saved trips.
const storeSuffix = env.mock ? '.mock' : '';
const trips = new TripsStore({ filePath: join(env.dataDir, `saved-trips${storeSuffix}.json`) });
const counters = new CountersStore({ filePath: join(env.dataDir, `counters${storeSuffix}.json`) });

const app = createApp({
  mock: env.mock,
  trips,
  counters,
  router: new OsrmRouter(),
  geocoder: new PhotonGeocoder(),
  // EXPLICIT bounded planning-budget override (coordinated acceptance):
  // present vars were validated at boot (malformed ones failed LOUDLY);
  // absent vars keep the SERVER_RUN_BUDGET defaults byte-identical.
  ...(env.planMaxCalls !== undefined || env.planDeadlineMs !== undefined
    ? {
        planRunBudget: {
          maxUpstreamCalls: env.planMaxCalls ?? SERVER_RUN_BUDGET.maxUpstreamCalls,
          deadlineMs: env.planDeadlineMs ?? SERVER_RUN_BUDGET.deadlineMs,
        },
      }
    : {}),
  ...(env.planRetries !== undefined ? { statiqRetries: env.planRetries } : {}),
  // Fresh client per planning run (single-run memo policy), armed with the
  // same deadline so Retry-After waits that cannot fit fail as throttled.
  // Sanitized upstream audit: endpoint + status + time + running count only.
  createStatiq: () => {
    const client = new StatiqClient({
      token: env.statiqToken as string,
      runDeadlineAt: Date.now() + SERVER_RUN_BUDGET.deadlineMs,
      onUpstreamCall: (entry: UpstreamAuditEntry) => {
        console.log(JSON.stringify({ type: 'upstream', ...entry }));
      },
    });
    return client;
  },
  // Sanitized run summary: outcome + call count. No route data ever.
  onRunComplete: (outcome, upstreamCalls) => {
    console.log(JSON.stringify({ type: 'plan-run', outcome, upstreamCalls }));
  },
  // AI planning is OFF unless all three env vars are set.
  ...(aiEnabled(env)
    ? { ai: { baseUrl: env.aiBaseUrl as string, apiKey: env.aiApiKey as string, model: env.aiModel as string } }
    : {}),
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`IndEV server on http://localhost:${info.port} (mock: ${env.mock}, ai: ${aiEnabled(env) ? 'on' : 'off'})`);
});

// Bounded shutdown: stop accepting work, close keep-alive sockets.
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
});
