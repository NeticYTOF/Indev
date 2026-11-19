import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  StatiqClient,
  TripsStore,
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
});

describe('GET /api/stations/:id', () => {
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
      // saved-trip-shaped payload (stations, not stops) must be rejected
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
});

describe('mock mode (synthetic data for UI work)', () => {
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
    const body = (await st.json()) as { station: { name: string; reliability: null } };
    expect(body.station.name).toContain('Statiq');
    expect(body.station.reliability).toBeNull();
  });
});
