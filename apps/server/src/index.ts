import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, TripsStore } from '@indeev/core';
import { aiEnabled, loadEnv } from './env.js';
import { createApp } from './app.js';

const root = process.cwd();
const env = loadEnv(root);

if (!env.mock && !env.statiqToken) {
  console.error(
    'STATIQ_API_TOKEN is missing. Add it to .env (see .env.example), or run in mock mode with INDEV_MOCK=1.',
  );
  process.exit(1);
}

mkdirSync(env.dataDir, { recursive: true });
const trips = new TripsStore({ filePath: join(env.dataDir, 'saved-trips.json') });
const counters = new CountersStore({ filePath: join(env.dataDir, 'counters.json') });

const app = createApp({
  mock: env.mock,
  trips,
  counters,
  router: new OsrmRouter(),
  geocoder: new PhotonGeocoder(),
  createStatiq: () => new StatiqClient({ token: env.statiqToken as string }),
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
