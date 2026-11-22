import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CheckedIdHistoryStore, CountersStore, OsrmRouter, PhotonGeocoder, TripsStore } from '@indeev/core';
import { aiEnabled, loadEnv } from './env.js';
import { createApp, SERVER_RUN_BUDGET } from './app.js';
import { buildStatiqFactory } from './statiq-factory.js';
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
const checkedIdHistory = new CheckedIdHistoryStore({ filePath: join(env.dataDir, `checked-id-history${storeSuffix}.json`) });

// The EFFECTIVE planning envelope for this launch: explicit validated
// overrides (malformed ones failed LOUDLY at boot) or the server defaults -
// byte-identical when absent. ONE source of truth for the app, the health
// report AND the client wiring (they can never disagree again).
const effectiveRunBudget = {
  maxUpstreamCalls: env.planMaxCalls ?? SERVER_RUN_BUDGET.maxUpstreamCalls,
  deadlineMs: env.planDeadlineMs ?? SERVER_RUN_BUDGET.deadlineMs,
};

const app = createApp({
  mock: env.mock,
  trips,
  counters,
  checkedIdHistory,
  router: new OsrmRouter(),
  geocoder: new PhotonGeocoder(),
  // The effective budget flows into createApp (both planning handlers +
  // the /api/health introspection) and into the client factory below from
  // the same composed object.
  planRunBudget: effectiveRunBudget,
  ...(env.planRetries !== undefined ? { statiqRetries: env.planRetries } : {}),
  // Server-owned detail profile, selected by INDEV_SELECTIVE_PROFILE.
  // Accepted values: standard20 (default), progressive40 (explicit opt-in).
  selectiveProfile: env.selectiveProfile,
  // Per-launch instance identity for the /api/health provenance echo
  // (launcher-generated UUID; absent = null, plain dev launches)
  ...(env.launchId !== undefined ? { launchId: env.launchId } : {}),
  allowedWebOrigins: env.allowedWebOrigins,
  // Fresh client per planning run (single-run memo policy), wired with the
  // EFFECTIVE deadline so Retry-After waits that cannot fit fail as
  // throttled - matching the budget /api/health reports, never the source
  // default. The factory forwards the per-launch retries override; absent
  // values keep the client's own defaults. Sanitized upstream audit: one
  // entry per attempt (endpoint + status + time + running count only).
  createStatiq: buildStatiqFactory({
    token: env.statiqToken as string,
    deadlineMs: effectiveRunBudget.deadlineMs,
    onUpstreamCall: (entry: UpstreamAuditEntry) => {
      console.log(JSON.stringify({ type: 'upstream', ...entry }));
    },
  }),
  // Sanitized run summary: outcome + call count. No route data ever.
  onRunComplete: (outcome, upstreamCalls, providerFailures) => {
    console.log(JSON.stringify({ type: 'plan-run', outcome, upstreamCalls, providerFailures }));
  },
  // Host-only diagnostic event: bounded reason codes and check counts.
  // Never prompts, model output, headers, secrets or public API fields.
  onPlanRunEvent: (event) => {
    console.log(JSON.stringify({ type: 'selective-diagnostics', ...event }));
  },
  // AI planning is OFF unless all three env vars are set.
  ...(aiEnabled(env)
    ? { ai: { baseUrl: env.aiBaseUrl as string, apiKey: env.aiApiKey as string, model: env.aiModel as string } }
    : {}),
});

const server = serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`IndEV server on http://${info.address}:${info.port} (${info.family}; ` +
    `mock: ${env.mock}, ai: ${aiEnabled(env) ? 'on' : 'off'})`);
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
