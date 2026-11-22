import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CountersStore, TripsStore } from '@indeev/core';
import { createApp } from '../src/app.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const origin = { label: 'A', lat: 28.6139, lon: 77.209 };
const destination = { label: 'B', lat: 26.9239, lon: 75.8267 };

describe('mock plan start SOC', () => {
  it.each([
    ['absent', undefined, undefined],
    ['zero clamps to five', 0, 5],
    ['fifty', 50, 50],
  ])('records %s validated start SOC through both mock endpoints',
    async (_label, requestStartSocPct, expectedStartSocPct) => {
    for (const endpoint of ['/api/plan', '/api/ai/plan']) {
      const dir = await mkdtemp(join(tmpdir(), `indev-mock-start-${_label}-`));
      dirs.push(dir);
      const app = createApp({
        mock: true,
        createStatiq: () => { throw new Error('no live calls in mock mode'); },
        router: endpointRouter() as never,
        geocoder: {} as never,
        trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
        counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
      });
      const response = await app.request(endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination,
          ...(requestStartSocPct === undefined ? {} : { startSocPct: requestStartSocPct }) }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { plan: { startSocPct?: number } };
      expect(body.plan.startSocPct).toBe(expectedStartSocPct);
    }
  });
});
