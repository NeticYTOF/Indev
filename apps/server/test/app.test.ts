import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  TripsStore,
  UpstreamBudget,
  UpstreamRunStoppedError,
  type RouteResult,
  type StatiqDetailsResponse,
  type StatiqMarkersResponse,
} from '@indeev/core';

// Isolated temp stores per test; no live upstream calls anywhere.
const tempDirs: string[] = [];
async function makeDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-server-test-'));
  tempDirs.push(dir);
  const deps: AppDeps = {
    createStatiq: () => new StatiqClient({ token: 'test' }),
    router: {
      route: async (): Promise<RouteResult> => ({
        distanceKm: 300,
        durationMin: 300,
        geometry: [
          { lat: 28.6, lon: 77.2 },
          { lat: 26.9, lon: 75.8 },
        ],
      }),
    } as unknown as OsrmRouter,
    geocoder: {
      search: async (q: string) => [
        { name: q, label: `${q}, India`, lat: 28.6, lon: 77.2, city: null, state: null, country: 'India' },
      ],
    } as unknown as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    ...overrides,
  };
  return deps;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const ORIGIN = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const DEST = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };

function liveStatiqFake() {
  // empty corridor: markers return no stations; details unused
  const statiq = {
    markers: async (): Promise<StatiqMarkersResponse> => ({
      ok: true,
      live: true,
      retained: false,
      source: 'test',
      count: 0,
      stations: [],
    }),
    detailsWithMeta: async (): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
      response: { ok: true, live: true, retained: false, source: 'test', station: null },
      fetchedAt: new Date(),
    }),
  } as unknown as StatiqClient;
  return statiq;
}

describe('GET /api/health', () => {
  it('reports ok with the running chargers-seen count', async () => {
    const deps = await makeDeps();
    const app = createApp(deps);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; chargersSeen: number; mock: boolean };
    expect(body.ok).toBe(true);
    expect(body.chargersSeen).toBe(0);
    expect(body.mock).toBe(false);
  });
});

describe('GET /api/vehicles', () => {
  it('lists the catalog with claims clearly noted', async () => {
    const app = createApp(await makeDeps());
    const res = await app.request('/api/vehicles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { default: string; catalog: Array<{ id: string }>; note: string };
    expect(body.default).toBe('tata-harrier-ev-75');
    expect(body.catalog.length).toBeGreaterThanOrEqual(10);
    expect(body.note).toContain('manufacturer claim');
  });
});

describe('planning coordinate bounds', () => {
  for (const endpoint of ['/api/plan', '/api/ai/plan']) {
    for (const field of ['origin', 'destination']) {
      it.each([{ lat: 91, lon: 77 }, { lat: -91, lon: 77 }, { lat: 28, lon: 181 }, { lat: 28, lon: -181 }])(
        `${endpoint} rejects out-of-range ${field}: %j`, async (coordinate) => {
          const app = createApp(await makeDeps({ mock: true }));
          const res = await app.request(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: ORIGIN, destination: DEST, [field]: { label: 'Invalid coordinate', ...coordinate } }),
          });
          expect(res.status).toBe(400);
          expect((await res.json() as { code: string }).code).toBe('bad_request');
        },
      );
    }
    it(`${endpoint} accepts inclusive valid coordinate boundaries`, async () => {
      const app = createApp(await makeDeps({ mock: true }));
      const res = await app.request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { label: 'Boundary A', lat: -90, lon: -180 }, destination: { label: 'Boundary B', lat: 90, lon: 180 } }),
      });
      expect(res.status).toBe(200);
    });
  }
});

describe('POST /api/plan', () => {
  it('rejects bad bodies with 400', async () => {
    const app = createApp(await makeDeps());
    const res = await app.request('/api/plan', { method: 'POST', body: 'null' });
    expect(res.status).toBe(400);
  });

  it('requires origin and destination coordinates', async () => {
    const app = createApp(await makeDeps());
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: { label: 'only label' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad_request');
  });

  it('returns a live plan and counts chargers seen', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const app = createApp(deps);
    // 300 km straight route from 100% needs no stops -> plan succeeds with 0 stops
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { stops: Array<{ station: { stationId: number } }>; stationsSeen: number; status: string; vehicle: { label: string } } };
    expect(body.plan.stops).toHaveLength(0);
    expect(body.plan.status).toBe('ok');
    expect(body.plan.vehicle.label).toContain('Harrier');
    const health = (await (await app.request('/api/health')).json()) as { chargersSeen: number };
    expect(health.chargersSeen).toBe(body.plan.stationsSeen);
  });

  it('rejects non-default vehicles without user-provided real-world range', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: ORIGIN,
        destination: DEST,
        vehicle: { entryId: 'tata-nexon-ev-lr-45' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('bad_vehicle');
    expect(body.error).toContain('real-world range');
  });

  it('returns the fine-grained cause in a budget-exhausted not_determined body', async () => {
    // markers throws the run-fatal budget stop -> the planner maps it to an
    // honest not_determined; the CAUSE must travel in the HTTP body so the
    // UI can stop calling every failure "the API is throttling".
    const statiq = {
      markers: async (): Promise<StatiqMarkersResponse> => {
        throw new UpstreamRunStoppedError('budget-exhausted', 3, 3);
      },
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; cause?: string };
    expect(body.code).toBe('not_determined');
    expect(body.cause).toBe('budget-exhausted');
    expect(body.error).toContain('NOT a verdict');
  });

  it('returns the throttled cause when the run budget records a fatal stop', async () => {
    // The double mirrors the real client: it receives the run budget via
    // attachRunBudget, stops it at the first markers call (429 + wait) and
    // throws. The body must carry cause:'throttled' plus the server-demanded
    // wait - "retry in a minute" is only honest for THIS cause.
    let runBudget: UpstreamBudget | null = null;
    const statiq = {
      attachRunBudget: (b: UpstreamBudget): void => {
        runBudget = b;
      },
      markers: async (): Promise<StatiqMarkersResponse> => {
        runBudget?.stop('throttled', 60_000);
        throw new UpstreamRunStoppedError('throttled', 1, 200, 60_000);
      },
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; cause?: string };
    expect(body.code).toBe('not_determined');
    expect(body.cause).toBe('throttled');
    expect(body.error).toContain('wait 60s');
  });

  it('omits cause for cause-less planning errors (no_route)', async () => {
    // A router with no route throws PlanningError('no_route') without a
    // cause; the body must NOT carry a cause key.
    const router = {
      route: async (): Promise<RouteResult> => {
        throw new PlanningError('No route found between these places.', 'no_route');
      },
    } as unknown as OsrmRouter;
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake(), router });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; cause?: string };
    expect(body.code).toBe('no_route');
    expect(body.cause).toBeUndefined();
    expect('cause' in body).toBe(false);
  });
});

describe('GET /api/stations/:id', () => {
  it.each(['empty-chargers', 'empty-connectors'] as const)('accepts explicit %s refresh evidence', async (kind) => {
    const station = { stationId: 42, name: 'Empty station', chargers: kind === 'empty-chargers' ? [] : [{ type: 'DC', connectors: [] }] };
    const statiq = {
      detailsWithMeta: async () => ({ response: { ok: true, station }, fetchedAt: new Date() }),
    } as unknown as StatiqClient;
    const app = createApp(await makeDeps({ createStatiq: () => statiq }));
    const res = await app.request('/api/stations/42');
    expect(res.status).toBe(200);
    const body = await res.json() as { station: { stationId: number; ccs2: { total: number } } };
    expect(body.station.stationId).toBe(42);
    expect(body.station.ccs2.total).toBe(0);
  });

  it.each(['missing-chargers', 'null-chargers', 'missing-connectors', 'null-connectors'] as const)('does not turn %s refresh evidence into a successful empty station', async (kind) => {
    const station = { stationId: 42, name: 'Incomplete station', chargers: [{ type: 'DC', connectors: [] }] };
    if (kind.endsWith('chargers')) Object.assign(station, { chargers: kind === 'null-chargers' ? null : undefined });
    else Object.assign(station.chargers[0]!, { connectors: kind === 'null-connectors' ? null : undefined });
    const statiq = {
      detailsWithMeta: async () => ({ response: { ok: true, station }, fetchedAt: new Date() }),
    } as unknown as StatiqClient;
    const app = createApp(await makeDeps({ createStatiq: () => statiq }));
    const res = await app.request('/api/stations/42');
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string; station?: unknown };
    expect(body.code).toBe('upstream_invalid');
    expect(body.station).toBeUndefined();
  });

  it.each(['wrong-id', 'not-ok'] as const)('rejects %s revalidation data instead of displaying another station', async (kind) => {
    let calls = 0;
    const statiq = {
      detailsWithMeta: async () => {
        calls++;
        return {
          response: { ok: kind !== 'not-ok', station: { stationId: kind === 'wrong-id' ? 43 : 42, name: 'Unexpected station', chargers: [] } },
          fetchedAt: new Date('2026-11-19T12:00:00Z'),
        };
      },
    } as unknown as StatiqClient;
    const app = createApp(await makeDeps({ createStatiq: () => statiq }));
    const res = await app.request('/api/stations/42');
    expect(res.status).toBe(502);
    const body = await res.json() as { code: string; station?: unknown };
    expect(body.code).toBe('upstream_invalid');
    expect(body.station).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('always fetches fresh details with fetchedAt (never a memo)', async () => {
    const fetchedAt = new Date('2026-11-19T12:00:00Z');
    let calls = 0;
    const statiq = {
      detailsWithMeta: async (): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => {
        calls++;
        return {
          response: {
            ok: true,
            live: true,
            retained: false,
            source: 'test',
            station: {
              stationId: 1790,
              name: 'Statiq Hotel The Suryaa Station',
              lat: 28.56,
              lon: 77.27,
              address: null,
              area: null,
              city: 'New Delhi',
              landmark: null,
              hours: '00:00 To 23:59',
              openText: 'Open Now',
              rating: 4.72,
              reviewCount: 4774,
              accessType: 'public',
              navUrl: 'n',
              stationUrl: 's',
              imageUrl: null,
              amenities: [],
              stepsToReach: null,
              chargers: [
                {
                  chargerId: 1,
                  name: 'DC',
                  type: 'DC',
                  kw: 120,
                  pricePerKwh: 22.75,
                  currency: 'INR',
                  lastUsedOn: '19/11/2026',
                  connectors: [
                    { displayId: 1, connectorId: 11, type: 'CCS-2', status: 'charging', available: false, note: 'Charging' },
                  ],
                },
              ],
              summary: null,
            },
          },
          fetchedAt,
        };
      },
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    const app = createApp(deps);

    const res1 = await app.request('/api/stations/1790');
    expect(res1.status).toBe(200);
    const body = (await res1.json()) as { station: { reliability: null; fetchedAt: string; ccs2: { occupied: number; isUsable: boolean } } };
    expect(body.station.reliability).toBeNull(); // never 0, never invented
    expect(body.station.fetchedAt).toBe('2026-11-19T12:00:00.000Z');
    expect(body.station.ccs2.occupied).toBe(1);
    expect(body.station.ccs2.isUsable).toBe(true);

    const res2 = await app.request('/api/stations/1790');
    await res2.json();
    expect(calls).toBe(2); // each view fetched fresh: no memo across requests
  });

  it('404s for unknown stations and 400s for bad ids', async () => {
    const statiq = {
      detailsWithMeta: async (): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
        response: { ok: true, live: true, retained: false, source: 'test', station: null },
        fetchedAt: new Date(),
      }),
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    const app = createApp(deps);
    expect((await app.request('/api/stations/42')).status).toBe(404);
    expect((await app.request('/api/stations/abc')).status).toBe(400);
  });
});

describe('saved trips (shared with MCP)', () => {
  it('saves a plan as minimal refs, lists, gets, deletes', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const app = createApp(deps);
    const planRes = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    const { plan } = (await planRes.json()) as { plan: Record<string, unknown> & { id: string } };

    const saveRes = await app.request('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, name: 'Weekend Jaipur run' }),
    });
    expect(saveRes.status).toBe(201);
    const { trip } = (await saveRes.json()) as { trip: { id: string; stations: Array<Record<string, unknown>> } };

    // minimal refs only: no brand/rating/plug/charger detail persisted
    const tripRes = await app.request(`/api/trips/${trip.id}`);
    const { trip: got } = (await tripRes.json()) as { trip: { stations: Array<Record<string, unknown>> } };
    expect((got.stations[0] ?? {}).brand).toBeUndefined();

    const listRes = await app.request('/api/trips');
    const { trips } = (await listRes.json()) as { trips: Array<{ id: string }> };
    expect(trips.some((t) => t.id === trip.id)).toBe(true);

    expect((await app.request(`/api/trips/${trip.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/trips/${trip.id}`)).status).toBe(404);
  });

  it('rejects malformed plan payloads with 400 instead of crashing', async () => {
    const app = createApp(await makeDeps());
    const res = await app.request('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: {
          id: 'bad',
          createdAt: '2026-11-19T12:00:00Z',
          origin: ORIGIN,
          destination: DEST,
          vehicle: { label: 'x', catalogId: null, batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: null },
          status: 'ok',
          routeDistanceKm: 285,
          routeDurationMin: 240,
          geometry: [[28.6, 77.2]],
          stations: [],
          totals: { distanceKm: 285, driveTimeMin: 240, chargeTimeMin: 0, totalTimeMin: 240, chargeKwh: 0, estPriceInr: null, finalSocPct: 33 },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad_request');
  });

  it.each([[], [{ lat: 28, lon: 77 }], [null, { lat: 28, lon: 77 }],
    [[28, 77], [27, 76]], [{ lat: 91, lon: 77 }, { lat: 28, lon: 77 }],
    [{ lat: 28, lon: '77' }, { lat: 28, lon: 77 }]].map((geometry) => ({ geometry })))(
    'rejects malformed saved route geometry %j without persisting', async ({ geometry }) => {
      const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('No live calls'); } });
      const app = createApp(deps);
      const response = await app.request('/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
      });
      const { plan } = await response.json();
      plan.geometry = geometry;
      const save = await app.request('/api/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
      });
      expect(save.status).toBe(400);
      expect((await save.json() as { code: string }).code).toBe('bad_request');
      expect(await deps.trips.list()).toEqual([]);
    },
  );

  it.each([
    { field: 'origin', value: { label: 'Bad', lat: 91, lon: 77 } },
    { field: 'destination', value: { label: 42, lat: 28, lon: 77 } },
    { field: 'station', value: { stationId: 1, name: 'Bad', lat: 28, lon: 181 } },
    { field: 'station', value: { stationId: 1, name: null, lat: 28, lon: 77 } },
    { field: 'name', value: 42 },
  ])('rejects invalid saved map/name field %j without persistence', async ({ field, value }) => {
    const deps = await makeDeps({ mock: true });
    const app = createApp(deps);
    const response = await app.request('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    const { plan } = await response.json();
    const body: Record<string, unknown> = { plan };
    if (field === 'station') plan.stops[0].station = value;
    else if (field === 'name') body.name = value;
    else plan[field] = value;
    const save = await app.request('/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(save.status).toBe(400);
    expect((await save.json() as { code: string }).code).toBe('bad_request');
    expect(await deps.trips.list()).toEqual([]);
  });

  it.each([null, {}, { stationId: 0 }, { stationId: -1 }, { stationId: 1.5 }])(
    'rejects malformed saved stop reference %j without writing a trip', async (station) => {
      const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('No live calls'); } });
      const app = createApp(deps);
      const response = await app.request('/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
      });
      const { plan } = await response.json();
      plan.stops = [{ station }];
      const save = await app.request('/api/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      expect(save.status).toBe(400);
      expect(await save.json()).toMatchObject({ code: 'bad_request' });
      expect(await deps.trips.list()).toHaveLength(0);
    },
  );

  it('never lets a synthetic plan enter the live store', async () => {
    const deps = await makeDeps();
    const app = createApp(deps);
    const synthetic = {
      plan: {
        id: 'mock-123',
        createdAt: '2026-11-19T12:00:00Z',
        origin: ORIGIN,
        destination: DEST,
        vehicle: { label: 'Tata Harrier EV (75 kWh)', catalogId: 'tata-harrier-ev-75', batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: null },
        status: 'ok',
        source: 'synthetic',
        routeDistanceKm: 415.2,
        routeDurationMin: 432,
        geometry: [[28.6, 77.2], [26.9, 75.8]],
        stops: [],
        totals: { distanceKm: 415.2, driveTimeMin: 432, chargeTimeMin: 32, totalTimeMin: 464, chargeKwh: 30, estPriceInr: 648, finalSocPct: 64 },
      },
    };
    const res = await app.request('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(synthetic),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('wrong_provenance');
    // and nothing leaked into the store
    const list = (await (await app.request('/api/trips')).json()) as { trips: unknown[] };
    expect(list.trips).toHaveLength(0);
  });

  it('never lets a live plan enter the mock store', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);
    const live = {
      plan: {
        id: 'plan-xyz',
        createdAt: '2026-11-19T12:00:00Z',
        origin: ORIGIN,
        destination: DEST,
        vehicle: { label: 'Tata Harrier EV (75 kWh)', catalogId: 'tata-harrier-ev-75', batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: null },
        status: 'ok',
        source: 'live',
        routeDistanceKm: 285,
        routeDurationMin: 240,
        geometry: [[28.6, 77.2], [26.9, 75.8]],
        stops: [],
        totals: { distanceKm: 285, driveTimeMin: 240, chargeTimeMin: 0, totalTimeMin: 240, chargeKwh: 0, estPriceInr: null, finalSocPct: 33 },
      },
    };
    const res = await app.request('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(live),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('wrong_provenance');
    const list = (await (await app.request('/api/trips')).json()) as { trips: unknown[] };
    expect(list.trips).toHaveLength(0);
  });

  it('saves its own synthetic plans in mock mode', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);
    const planRes = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    const { plan } = (await planRes.json()) as { plan: Record<string, unknown> };
    const saveRes = await app.request('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, name: 'Mock run' }),
    });
    expect(saveRes.status).toBe(201);
    const { trip } = (await saveRes.json()) as { trip: { source: string; stations: Array<Record<string, unknown>> } };
    expect(trip.source).toBe('synthetic');
    // mock stations carry no fabricated URLs and are flagged synthetic
    expect((trip.stations[0] ?? {}).stationUrl).toBeUndefined(); // saved refs are minimal
  });
});

describe('mock mode (synthetic data for UI work)', () => {
  it('echoes the requested vehicle in synthetic plans (catalog, with claims kept separate)', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: ORIGIN,
        destination: DEST,
        vehicle: { entryId: 'tata-nexon-ev-lr-45', realWorldRangeKm: 300 },
      }),
    });
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as {
      plan: { vehicle: { label: string; catalogId: string; batteryKwh: number; claimedRangeKm: number | null; realWorldRangeKm: number | null } };
    };
    expect(plan.vehicle.catalogId).toBe('tata-nexon-ev-lr-45');
    expect(plan.vehicle.label).toContain('Nexon');
    expect(plan.vehicle.batteryKwh).toBe(45);
    // claimed range stays the mfr claim; the user's input stays "yours"
    expect(plan.vehicle.claimedRangeKm).toBe(465);
    expect(plan.vehicle.realWorldRangeKm).toBe(300);
  });

  it('echoes custom vehicles truthfully in synthetic plans (no invented claim)', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: ORIGIN,
        destination: DEST,
        vehicle: { custom: { label: 'My EV', batteryKwh: 60, realWorldRangeKm: 350 } },
      }),
    });
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as {
      plan: { vehicle: { label: string; catalogId: string | null; batteryKwh: number; claimedRangeKm: number | null; realWorldRangeKm: number | null } };
    };
    expect(plan.vehicle.label).toBe('My EV');
    expect(plan.vehicle.catalogId).toBeNull();
    expect(plan.vehicle.batteryKwh).toBe(60);
    expect(plan.vehicle.realWorldRangeKm).toBe(350);
    // no manufacturer claim invented for customs
    expect(plan.vehicle.claimedRangeKm).toBeNull();
  });

  it('validates vehicles identically in mock mode (real-world range required)', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: ORIGIN,
        destination: DEST,
        vehicle: { entryId: 'tata-nexon-ev-lr-45' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad_vehicle');
  });

  it('serves synthetic geocode, plans and stations without live calls', async () => {
    const deps = await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } });
    const app = createApp(deps);

    const geo = (await (await app.request('/api/geocode?q=jai')).json()) as { hits: Array<{ name: string }> };
    expect(geo.hits[0]?.name).toBe('Jaipur');

    const planRes = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(planRes.status).toBe(200);
    const { plan } = (await planRes.json()) as { plan: { stops: Array<{ station: { stationId: number } }> } };
    expect(plan.stops.length).toBeGreaterThan(0);

    const st = await app.request('/api/stations/9101');
    expect(st.status).toBe(200);
    const body = (await st.json()) as { station: { name: string; reliability: null; synthetic: boolean; stationUrl: string | null; navUrl: string | null } };
    expect(body.station.name).toContain('Statiq');
    expect(body.station.reliability).toBeNull();
    expect(body.station.synthetic).toBe(true);
    // no fabricated real-domain URLs on synthetic stations
    expect(body.station.stationUrl).toBeNull();
    expect(body.station.navUrl).toBeNull();
  });
});
