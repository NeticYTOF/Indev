import fs from 'node:fs/promises';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it.each([450, 5])('uses or rejects a supplied default-vehicle real-world range (%s km)', async (realWorldRangeKm) => {
    const app = createApp(await makeDeps({ mock: true }));
    const res = await app.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST, vehicle: { realWorldRangeKm } }) });
    expect(res.status).toBe(realWorldRangeKm === 450 ? 200 : 400);
    const body = await res.json();
    if (res.ok) expect(body.plan.vehicle.realWorldRangeKm).toBe(450);
    else expect(body.code).toBe('bad_vehicle');
  });

  it('preserves actual corrupt counter bytes while health and computed plans remain usable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'indeev-counter-http-'));
    tempDirs.push(dir);
    const path = join(dir, 'counters.json');
    const original = '{"incomplete":';
    await writeFile(path, original);
    const app = createApp(await makeDeps({ mock: true, counters: new CountersStore({ filePath: path }) }));
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ mock: true, chargersSeen: null, counterAvailable: false });
    const res = await app.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
    expect(res.status).toBe(200);
    expect((await res.json()).plan.warnings.join(' ')).toContain('counter unavailable');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('keeps health mode metadata available when the counter file is corrupt', async () => {
    const deps = await makeDeps({ counters: { load: async () => { throw new Error('counter corrupt'); } } as unknown as CountersStore });
    const res = await createApp(deps).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mock: false, chargersSeen: null, counterAvailable: false });
  });

  it.each([false, true])('delivers a computed plan and honest audit despite counter failure (mock=%s)', async (mock) => {
    const audit: string[] = [];
    const statiq = { ...liveStatiqFake(), upstreamCallsMade: () => 17 } as unknown as StatiqClient;
    const deps = await makeDeps({ mock, createStatiq: () => statiq,
      counters: { addChargersSeen: async () => { throw new Error('counter corrupt'); } } as unknown as CountersStore,
      onRunComplete: (outcome, calls) => audit.push(`${outcome}:${calls}`),
    });
    const res = await createApp(deps).request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.warnings.some((warning: string) => warning.includes('not added to the saved running count'))).toBe(true);
    expect(audit).toEqual([mock ? 'ok:0' : 'ok:17']);
  });

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

describe('optional upstream counter neutrality', () => {
  const planBody = JSON.stringify({ origin: ORIGIN, destination: DEST });

  async function requestWith(statiq: unknown): Promise<{
    status: number;
    completions: Array<{ outcome: string; calls: number }>;
  }> {
    const completions: Array<{ outcome: string; calls: number }> = [];
    const app = createApp(await makeDeps({
      mock: false,
      createStatiq: () => statiq as StatiqClient,
      onRunComplete: (outcome, calls) => { completions.push({ outcome, calls }); },
    }));
    const res = await app.request('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: planBody,
    });
    return { status: res.status, completions };
  }

  function fakeStatiq(): Record<string, unknown> {
    return {
      ...liveStatiqFake(),
      attachRunBudget: () => {},
    } as unknown as Record<string, unknown>;
  }

  it('accepts an injected double with no counter method and reports one completion', async () => {
    const result = await requestWith(fakeStatiq());
    expect(result.status).toBe(200);
    expect(result.completions).toEqual([{ outcome: 'ok', calls: 0 }]);
  });

  it('neutralizes throwing, invalid, and throwing-getter counters', async () => {
    const throwing = fakeStatiq();
    throwing.upstreamCallsMade = () => { throw new Error('counter method'); };
    expect(await requestWith(throwing)).toMatchObject({
      status: 200, completions: [{ outcome: 'ok', calls: 0 }],
    });

    const invalid = fakeStatiq();
    invalid.upstreamCallsMade = () => Number.NaN;
    expect(await requestWith(invalid)).toMatchObject({
      status: 200, completions: [{ outcome: 'ok', calls: 0 }],
    });

    const getter = fakeStatiq() as Record<string, unknown>;
    Object.defineProperty(getter, 'upstreamCallsMade', {
      get() { throw new Error('counter getter'); },
      enumerable: true,
    });
    expect(await requestWith(getter)).toMatchObject({
      status: 200, completions: [{ outcome: 'ok', calls: 0 }],
    });
  });
});

describe('completion failure evidence', () => {
  it('delivers completion evidence even if the observer throws', async () => {
    const observed: Array<{ outcome: string; calls: number; report?: unknown }> = [];
    const app = createApp(await makeDeps({ mock: true,
      createStatiq: () => { throw new Error('live call in mock mode!'); },
      onRunComplete: (outcome, calls, report) => {
        observed.push({ outcome, calls, report });
        throw new Error('observer failure must not alter the response');
      },
    }));
    const res = await app.request('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(200);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.outcome).toBe('ok');
    expect(observed[0]?.report).toMatchObject({ failures: [], omittedFailureCount: 0 });
  });
});

describe('browser origin and mutation boundary', () => {
  const planBody = JSON.stringify({ origin: ORIGIN, destination: DEST });
  const planHeaders = { 'Content-Type': 'application/json' };

  async function counterAfter(res: Response, app: ReturnType<typeof createApp>): Promise<number | null> {
    expect(res.status).toBe(200);
    const health = await (await app.request('/api/health')).json() as { chargersSeen: number | null };
    return health.chargersSeen;
  }

  it('Vite proxy browser JSON: allowed localhost origin + same-origin site persists one run', async () => {
    const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { ...planHeaders, origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' },
      body: planBody,
    });
    expect(await counterAfter(res, app)).toBe(48);
  });

  it('direct browser backend JSON: same-site origin is denied before a run', async () => {
    const statiq = { ...liveStatiqFake(), upstreamCallsMade: () => 7 } as unknown as StatiqClient;
    const audit: string[] = [];
    const app = createApp(await makeDeps({ mock: true, createStatiq: () => statiq,
      onRunComplete: (outcome) => audit.push(outcome),
    }));
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { ...planHeaders, origin: 'http://localhost:5174', 'sec-fetch-site': 'same-site' },
      body: planBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('origin_denied');
    expect(audit).toEqual([]);
    expect(((await (await app.request('/api/health')).json()) as { chargersSeen: number }).chargersSeen).toBe(0);
  });

  it('simple cross-origin text/plain cannot start a run', async () => {
    const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', origin: 'http://localhost:5174', 'sec-fetch-site': 'same-site' },
      body: planBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('origin_denied');
    expect(((await (await app.request('/api/health')).json()) as { chargersSeen: number }).chargersSeen).toBe(0);
  });

  it('allowed origin with text/plain is rejected as non-JSON before execution', async () => {
    const app = createApp(await makeDeps({ mock: true }));
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
      body: planBody,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('bad_request');
    expect(((await (await app.request('/api/health')).json()) as { chargersSeen: number }).chargersSeen).toBe(0);
  });

  it('direct Node JSON without Origin keeps the nonbrowser client contract', async () => {
    const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
    const res = await app.request('/api/plan', { method: 'POST', headers: planHeaders, body: planBody });
    expect(await counterAfter(res, app)).toBe(48);
  });

  it('untrusted browser origin cannot save or delete trips', async () => {
    const deps = await makeDeps({ mock: true });
    const app = createApp(deps);
    const planned = await app.request('/api/plan', { method: 'POST', headers: planHeaders, body: planBody });
    const plan = ((await planned.json()) as { plan: unknown }).plan;
    const forged = { origin: 'http://localhost:9999', 'sec-fetch-site': 'same-site' };

    const save = await app.request('/api/trips', {
      method: 'POST',
      headers: { ...planHeaders, ...forged },
      body: JSON.stringify({ plan }),
    });
    expect(save.status).toBe(403);
    expect(((await save.json()) as { code: string }).code).toBe('origin_denied');
    expect(((await (await app.request('/api/trips')).json()) as { trips: unknown[] }).trips).toHaveLength(0);

    const allowedSave = await app.request('/api/trips', {
      method: 'POST',
      headers: { ...planHeaders, origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ plan, name: 'origin fixture' }),
    });
    expect(allowedSave.status).toBe(201);
    const id = (((await allowedSave.json()) as { trip: { id: string } }).trip).id;
    const del = await app.request(`/api/trips/${id}`, { method: 'DELETE', headers: forged });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { code: string }).code).toBe('origin_denied');
    expect(((await (await app.request('/api/trips')).json()) as { trips: unknown[] }).trips).toHaveLength(1);
  });

  it('untrusted browser origin cannot consume geocode or station providers', async () => {
    const geocode = vi.fn(async () => []);
    const createStatiq = vi.fn(() => ({}) as unknown as StatiqClient);
    const app = createApp(await makeDeps({ mock: false, geocoder: { search: geocode } as unknown as PhotonGeocoder, createStatiq }));
    const headers = { origin: 'http://localhost:9999', 'sec-fetch-site': 'same-site' };
    expect((await app.request('/api/geocode?q=delhi', { headers })).status).toBe(403);
    expect((await app.request('/api/stations/9101', { headers })).status).toBe(403);
    expect(geocode).not.toHaveBeenCalled();
    expect(createStatiq).not.toHaveBeenCalled();
  });
  it('no-Origin browser Fetch Metadata alone denies provider reads', async () => {
    const geocode = vi.fn(async () => []);
    const createStatiq = vi.fn(() => ({}) as unknown as StatiqClient);
    const app = createApp(await makeDeps({ mock: false, geocoder: { search: geocode } as unknown as PhotonGeocoder, createStatiq }));
    for (const site of ['same-site', 'cross-site']) {
      expect((await app.request('/api/geocode?q=delhi', { headers: { 'sec-fetch-site': site } })).status).toBe(403);
      expect((await app.request('/api/stations/9101', { headers: { 'sec-fetch-site': site } })).status).toBe(403);
    }
    expect(geocode).not.toHaveBeenCalled();
    expect(createStatiq).not.toHaveBeenCalled();
  });

  it('no-Origin browser Fetch Metadata alone denies mutation before a run', async () => {
    const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
    const res = await app.request('/api/plan', {
      method: 'POST',
      headers: { ...planHeaders, 'sec-fetch-site': 'same-site' },
      body: planBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('origin_denied');
    expect(((await (await app.request('/api/health')).json()) as { chargersSeen: number }).chargersSeen).toBe(0);
  });

  it('no-Origin clients without non-same-origin metadata keep working', async () => {
    const geocode = vi.fn(async () => []);
    // Non-mock is required here: the mock branch correctly serves synthetic
    // geocode results without calling the injected provider.
    const providerApp = createApp(await makeDeps({ mock: false, geocoder: { search: geocode } as unknown as PhotonGeocoder }));
    expect((await providerApp.request('/api/geocode?q=delhi')).status).toBe(200);
    expect((await providerApp.request('/api/geocode?q=delhi', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect(geocode).toHaveBeenCalledTimes(2);

    const planApp = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
    const planned = await planApp.request('/api/plan', { method: 'POST', headers: planHeaders, body: planBody });
    expect(await counterAfter(planned, planApp)).toBe(48);
  });

});

describe('malformed planning inputs', () => {
  const endpoints = ['/api/plan', '/api/ai/plan'];

  const vehicleCases: Array<[string, unknown]> = [
    ['string', 'harrier'],
    ['array', []],
    ['number', 123],
    ['boolean', true],
    ['custom label number', { custom: { label: 123, batteryKwh: 20, realWorldRangeKm: 80 } }],
    ['custom negative claim', { custom: { batteryKwh: 60, claimedRangeKm: -1, realWorldRangeKm: 300 } }],
    ['custom string claim', { custom: { batteryKwh: 60, claimedRangeKm: '500', realWorldRangeKm: 300 } }],
  ];

  for (const endpoint of endpoints) {
    it.each(vehicleCases)(`${endpoint} rejects malformed vehicle %s`, async (_name, vehicle) => {
      const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
      const res = await app.request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, destination: DEST, vehicle }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('bad_vehicle');
    });

    it.each([null, '90', true, Number.NaN])(`${endpoint} rejects malformed startSocPct %j`, async (startSocPct) => {
      const app = createApp(await makeDeps({ mock: true, createStatiq: () => { throw new Error('live call in mock mode!'); } }));
      const res = await app.request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, destination: DEST, startSocPct }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('bad_request');
    });
  }
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

it('returns the actual saved trip and committed outcome when lock cleanup fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indev-http-lock-')); tempDirs.push(dir);
  const path = join(dir, 'trips.json');
  const deps = await makeDeps({ mock: true, trips: new TripsStore({ filePath: path }) }); const app = createApp(deps);
  const planned = await app.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
  const { plan } = await planned.json();
  const spy = vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup refusal'));
  try {
    const response = await app.request('/api/trips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    expect(response.status).toBe(201); const body = await response.json();
    expect(body.trip.id).toBe(plan.id); expect(body.storage).toEqual({ committed: true, lockReleased: false });
    expect(body.warnings.join(' ')).toContain('Do not retry');
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

it.each([true, false])('preserves delete completion and no-op outcomes despite cleanup failure: %s', async exists => {
  const dir = await mkdtemp(join(tmpdir(), 'indev-http-delete-lock-')); tempDirs.push(dir);
  const path = join(dir, 'trips.json'); await writeFile(path, JSON.stringify(exists ? [{ id: 'A' }] : []));
  const app = createApp(await makeDeps({ mock: true, trips: new TripsStore({ filePath: path }) }));
  const spy = vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup refusal'));
  try {
    const response = await app.request('/api/trips/A', { method: 'DELETE' });
    expect(response.status).toBe(exists ? 200 : 404);
    expect((await response.json()).storage).toEqual({ committed: exists, lockReleased: false });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
  } finally { spy.mockRestore(); }
});

it('delivers an HTTP plan with unconfirmed counter warning after actual commit and cleanup failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indev-http-counter-lock-')); tempDirs.push(dir);
  const path = join(dir, 'counter.json'); const counters = new CountersStore({ filePath: path });
  const app = createApp(await makeDeps({ mock: true, counters }));
  const spy = vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup refusal'));
  try {
    const response = await app.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
    expect(response.status).toBe(200); const { plan } = await response.json();
    expect(plan.warnings.join(' ')).toContain('persistence could not be confirmed');
    expect((await counters.load()).chargersSeen).toBe(plan.stationsSeen);
  } finally { spy.mockRestore(); }
});

it('returns explicit locked HTTP failure without modifying a busy store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indev-http-busy-')); tempDirs.push(dir);
  const path = join(dir, 'trips.json'); await writeFile(path, '[]'); await fs.mkdir(path + '.lock');
  const app = createApp(await makeDeps({ mock: true, trips: new TripsStore({ filePath: path }) }));
  const response = await app.request('/api/trips/A', { method: 'DELETE' });
  expect(response.status).toBe(423); const body = await response.json();
  expect(body.code).toBe('storage_busy'); expect(body.error).toContain('No write was attempted');
  expect(await readFile(path, 'utf8')).toBe('[]');
  expect(await fs.readdir(path + '.lock')).toEqual([]);
}, 10_000);

it.each([
  ['vehicle', 'realWorldRangeKm', '<span data-range-proof>local marker</span>'],
  ['vehicle', 'claimedRangeKm', '627'],
  ['vehicle', 'batteryKwh', 0],
  ['vehicle', 'label', 42],
  ['vehicle', 'catalogId', {}],
  ['totals', 'totalTimeMin', '464'],
  ['totals', 'chargeTimeMin', -1],
  ['totals', 'finalSocPct', 101],
  ['totals', 'estPriceInr', 'unknown'],
  ['plan', 'createdAt', 'not-a-date'],
  ['plan', 'status', 'unknown'],
  ['plan', 'routeDistanceKm', -1],
  ['stop', 'chargeKwh', '12'],
  ['stop', 'pricePerKwh', {}],
  ['stop', 'arriveSocPct', -1],
] as const)('rejects malformed new saved metadata %s.%s without persisting', async (section, field, value) => {
  const deps = await makeDeps({ mock: true }); const app = createApp(deps);
  const planned = await app.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
  const { plan } = await planned.json();
  const target = section === 'plan' ? plan : section === 'stop' ? plan.stops[0] : plan[section];
  target[field] = value;
  const response = await app.request('/api/trips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
  expect(response.status).toBe(400); expect((await response.json()).code).toBe('bad_request');
  expect(await deps.trips.list()).toEqual([]);
});

it.each([{ live: false }, { retained: true }, { live: 'true' }, { retained: null }])('HTTP refresh refuses nonfresh envelope %j before not-found or live view', async evidence => {
  const statiq = { detailsWithMeta: async () => ({ response: { ok: true, station: null, ...evidence }, fetchedAt: new Date() }) } as unknown as StatiqClient;
  const app = createApp(await makeDeps({ createStatiq: () => statiq }));
  const res = await app.request('/api/stations/42');
  expect(res.status).toBe(502); expect(await res.json()).toMatchObject({ code: 'upstream_invalid' });
});

it('HTTP refresh maps real-client nonfresh evidence to502 without treating it as absent station', async () => {
  let calls = 0;
  const app = createApp(await makeDeps({ createStatiq: () => new StatiqClient({ token: 'offline-only', retries: 2, fetchImpl: (async () => {
    calls++; return new Response(JSON.stringify({ ok: true, live: false, retained: true, station: null }));
  }) as typeof fetch }) }));
  const result = await app.request('/api/stations/42');
  expect(result.status).toBe(502); expect(await result.json()).toMatchObject({ code: 'upstream_invalid' }); expect(calls).toBe(1);
});
describe('ordered stopover API boundary', () => {
  const endpoints = ['/api/plan', '/api/ai/plan'] as const;
  type Place = { label: string; lat: number; lon: number };
  type RouteCall = { origin: Place; destination: Place; via: readonly Place[] };
  type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };
  const viaOne: Place[] = [{ label: 'Ahmedabad', lat: 23.02, lon: 72.57 }];
  const viaFive: Place[] = [
    { label: 'Nagpur', lat: 21.15, lon: 79.09 },
    { label: 'Indore', lat: 22.72, lon: 75.86 },
    { label: 'Ahmedabad', lat: 23.02, lon: 72.57 },
    { label: 'Surat', lat: 21.17, lon: 72.83 },
    { label: 'Vapi', lat: 20.37, lon: 72.91 },
  ];
  const badVia: unknown[] = [
    null,
    { label: 'X', lat: 23, lon: 72 },
    Array.from({ length: 6 }, (_, i) => ({ label: `V${i}`, lat: 20 + i, lon: 70 + i })),
    [{ label: '   ', lat: 23, lon: 72 }],
    [{ label: 'Not finite', lat: Number.NaN, lon: 72 }],
    [{ label: 'Out of range', lat: 91, lon: 72 }],
  ];
  const noViaBody = JSON.stringify({ origin: ORIGIN, destination: DEST });
  const withViaBody = (via: unknown, startSocPct?: number): string =>
    JSON.stringify({ origin: ORIGIN, destination: DEST, via, startSocPct });
  const aiConfig = { baseUrl: 'https://ai.test/v1', apiKey: 'sk-test', model: 'test-model' };
  const shortRoute = (): RouteResult => ({
    distanceKm: 2,
    durationMin: 2,
    geometry: [
      { lat: 28.6, lon: 77.2 },
      { lat: 28.61, lon: 77.21 },
    ],
  });

  async function request(path: string, body: string, mock = false) {
    const calls = { factory: 0, router: 0, ai: 0 };
    const routes: RouteCall[] = [];
    const deps = await makeDeps({
      mock,
      ai: aiConfig,
      aiCall: async (_messages: AiMessage[]): Promise<string> => {
        calls.ai += 1;
        return JSON.stringify({ chosenStationIds: [] });
      },
      createStatiq: (_opts?: { retries?: number }): StatiqClient => {
        calls.factory += 1;
        return liveStatiqFake();
      },
      router: {
        route: async (
          origin: Place,
          destination: Place,
          _signal: AbortSignal | undefined,
          via: readonly Place[] = [],
        ): Promise<RouteResult> => {
          calls.router += 1;
          routes.push({ origin, destination, via });
          return shortRoute();
        },
      } as unknown as OsrmRouter,
    });
    const response = await createApp(deps).request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return { response, calls, routes };
  }

  it.each(endpoints)('%s rejects malformed stopovers before any run', async (path) => {
    for (const via of badVia) {
      const { response, calls } = await request(path, withViaBody(via));
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('bad_request');
      expect(calls).toEqual({ factory: 0, router: 0, ai: 0 });
    }
  });
  it.each(endpoints)('%s refuses mock stopovers but keeps A-B demo working', async (path) => {
    for (const via of [viaOne, viaFive]) {
      const { response, calls } = await request(path, withViaBody(via), true);
      expect(response.status).toBe(422);
      expect((await response.json() as { code: string }).code).toBe('unsupported_mock_stopovers');
      expect(calls).toEqual({ factory: 0, router: 0, ai: 0 });
    }
    for (const body of [noViaBody, withViaBody([])]) {
      const { response, calls } = await request(path, body, true);
      expect(response.status).toBe(200);
      expect(calls).toEqual({ factory: 0, router: 0, ai: 0 });
    }
  });

  for (const path of endpoints) {
    for (const [name, via] of [['one', viaOne], ['five', viaFive]] as const) {
      it(`${path} routes ${name} stopover set in one full route`, async () => {
        const low = await request(path, withViaBody(via, 60));
        const high = await request(path, withViaBody(via, 100));
        const aiCalls = path === '/api/ai/plan' ? 1 : 0;
        const readings: number[] = [];
        for (const result of [low, high]) {
          expect(result.response.status).toBe(200);
          expect(result.calls).toEqual({ factory: 1, router: 1, ai: aiCalls });
          expect(result.routes).toHaveLength(1);
          const call = result.routes[0] as RouteCall;
          expect(call.origin).toEqual(ORIGIN);
          expect(call.destination).toEqual(DEST);
          expect(call.via).toEqual(via);
          const body = await result.response.json() as {
            plan: { via?: Place[]; totals: { finalSocPct: number } };
          };
          expect(body.plan.via).toEqual(via);
          readings.push(body.plan.totals.finalSocPct);
        }
        expect(readings[1] as number).toBeGreaterThan(readings[0] as number);
      });
    }
  }
});
describe('maximum charger power wire validation', () => {
  const endpoints = ['/api/plan', '/api/ai/plan'] as const;
  function capHarness() {
    const calls = { router: 0, factory: 0, ai: 0 };
    return { calls };
  }
  function mixedCapStatiq(): StatiqClient {
    const station = {
      stationId: 7201, name: 'Mixed power site', lat: 27.75, lon: 76.5,
      address: null, area: null, city: null, landmark: null,
      hours: '00:00 To 23:59', openText: 'Open Now', rating: null, reviewCount: null,
      accessType: 'public', navUrl: '', stationUrl: '', imageUrl: null, amenities: [],
      stepsToReach: null,
      chargers: [
        { chargerId: 7210, name: '180 kW charger', type: 'DC', kw: 180, pricePerKwh: 18,
          currency: 'INR', lastUsedOn: null,
          connectors: [{ displayId: 1, connectorId: 72100, type: 'CCS-2',
            status: 'available', available: true, note: null }] },
        { chargerId: 7220, name: '60 kW charger', type: 'DC', kw: 60, pricePerKwh: null,
          currency: 'INR', lastUsedOn: null,
          connectors: [{ displayId: 1, connectorId: 72200, type: 'CCS-2',
            status: 'available', available: true, note: null }] },
      ],
    };
    return {
      markers: async (): Promise<StatiqMarkersResponse> => ({
        ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: station.stationId, name: station.name, lat: station.lat,
          lon: station.lon, address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
      }),
      detailsWithMeta: async (): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
        response: { ok: true, live: true, retained: false, source: 'test', station: station as never },
        fetchedAt: new Date(),
      }),
    } as unknown as StatiqClient;
  }
  it.each(endpoints.map((path) => ({ path })))('forwards the charger cap on $path', async ({ path }) => {
    const deps = await makeDeps({
      createStatiq: () => mixedCapStatiq(),
      ...(path === '/api/ai/plan'
        ? { ai: { baseUrl: 'https://ai.test/v1', apiKey: 'sk-test', model: 'test-model' },
            aiCall: async () => JSON.stringify({ chosenStationIds: [] }) }
        : {}),
    });
    const res = await createApp(deps).request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, startSocPct: 20, maxChargerKw: 100 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { plan: { stops: Array<{
      pricePerKwh: number | null; estPriceInr: number | null;
      selectedCharger?: { kw: number; pricePerKwh: number | null };
    }> } };
    const stopped = body.plan.stops[0];
    expect(stopped?.selectedCharger).toMatchObject({ kw: 60, pricePerKwh: null });
    expect(stopped?.pricePerKwh).toBeNull();
    expect(stopped?.estPriceInr).toBeNull();
  });
  it.each(endpoints)('%s rejects invalid charger caps before dispatch', async (path) => {
    const { calls } = capHarness();
    const deps = await makeDeps({
      router: { route: async () => { calls.router += 1; throw new Error('unexpected route'); } } as unknown as OsrmRouter,
      createStatiq: () => { calls.factory += 1; throw new Error('unexpected provider'); },
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'sk-test', model: 'test-model' },
      aiCall: async () => { calls.ai += 1; throw new Error('unexpected AI'); },
    });
    for (const maxChargerKw of [null, 0, -1, '60', {}]) {
      const res = await createApp(deps).request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, destination: DEST, maxChargerKw }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('bad_request');
    }
    expect(calls).toEqual({ router: 0, factory: 0, ai: 0 });
  });
});
describe('saved trip stopover wire validation', () => {
  async function saveFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'indev-server-save-via-test-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'trips.json');
    await writeFile(filePath, '[]');
    let providerCalls = 0;
    const deps = await makeDeps({
      mock: true,
      trips: new TripsStore({ filePath }),
      createStatiq: () => { providerCalls += 1; throw new Error('provider must not be called'); },
    });
    const app = createApp(deps);
    const planned = await app.request('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(planned.status).toBe(200);
    const { plan } = await planned.json() as { plan: Record<string, unknown> & { id: string } };
    return { app, filePath, plan, providerCalls: () => providerCalls };
  }

  async function expectEmptyStore(app: ReturnType<typeof createApp>, filePath: string, providerCalls: () => number): Promise<void> {
    expect(providerCalls()).toBe(0);
    expect(await readFile(filePath, 'utf8')).toBe('[]');
    const list = await app.request('/api/trips');
    expect(list.status).toBe(200);
    expect((await list.json() as { trips: unknown[] }).trips).toEqual([]);
  }

  const malformed = [
    { name: 'null', via: null },
    { name: 'object', via: { label: 'A', lat: 23, lon: 72 } },
    { name: 'string', via: 'Jaipur' },
    { name: 'six stops', via: Array.from({ length: 6 }, (_, i) => ({ label: `S${i}`, lat: 20 + i, lon: 70 + i })) },
    { name: 'blank label', via: [{ label: '   ', lat: 23, lon: 72 }] },
    { name: 'out-of-range', via: [{ label: 'Bad', lat: 91, lon: 72 }] },
    { name: 'wrong coordinate type', via: [{ label: 'Bad', lat: '23', lon: 72 }] },
    { name: 'null member', via: [null] },
  ];

  it.each(malformed)('rejects malformed save stopovers: $name', async ({ via }) => {
    const { app, filePath, plan, providerCalls } = await saveFixture();
    const response = await app.request('/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: { ...plan, via }, name: 'Invalid stops' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('bad_request');
    await expectEmptyStore(app, filePath, providerCalls);
  });

  const stopoverSets = [
    { name: 'one', places: [{ label: '  Ahmedabad  ', lat: 23.02, lon: 72.57, extra: 'strip' }] },
    { name: 'five', places: [
      { label: '  Nagpur  ', lat: 21.15, lon: 79.09, extra: 'strip' },
      { label: '  Indore  ', lat: 22.72, lon: 75.86, extra: 'strip' },
      { label: '  Ahmedabad  ', lat: 23.02, lon: 72.57, extra: 'strip' },
      { label: '  Surat  ', lat: 21.17, lon: 72.83, extra: 'strip' },
      { label: '  Vapi  ', lat: 20.37, lon: 72.91, extra: 'strip' },
    ] },
  ];

  it.each(stopoverSets)('saves exact ordered normalized stopovers: $name', async ({ places }) => {
    const { app, plan, providerCalls } = await saveFixture();
    const input = { plan: { ...plan, via: places }, name: 'Stopover save' };
    const beforeInput = JSON.stringify(input);
    const response = await app.request('/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    expect(providerCalls()).toBe(0);
    expect(JSON.stringify(input)).toBe(beforeInput);
    const expected = places.map(({ label, lat, lon }) => ({ label: label.trim(), lat, lon }));
    const { trip } = await response.json() as { trip: Record<string, unknown> };
    expect(trip.via).toEqual(expected);
    expect(trip.geometry).toEqual((plan.geometry as Array<{ lat: number; lon: number }>).map(p => [p.lat, p.lon]));
    expect(trip.totals).toEqual(plan.totals);
    const got = await app.request(`/api/trips/${trip.id as string}`);
    const { trip: fetched } = await got.json() as { trip: Record<string, unknown> };
    expect(fetched.via).toEqual(expected);
    for (const place of fetched.via as Array<Record<string, unknown>>) {
      expect(Object.keys(place).sort()).toEqual(['label', 'lat', 'lon']);
    }
    const list = await app.request('/api/trips');
    const { trips } = await list.json() as { trips: Array<Record<string, unknown>> };
    expect(trips).toHaveLength(1);
    expect(trips[0]?.via).toEqual(expected);
  });

  it.each([
    { name: 'omitted', attach: false },
    { name: 'empty', attach: true },
  ])('omits saved via for A-B plans: $name', async ({ attach }) => {
    const { app, plan } = await saveFixture();
    const requestPlan = { ...plan };
    if (attach) requestPlan.via = [];
    const response = await app.request('/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: requestPlan, name: 'A-B save' }),
    });
    expect(response.status).toBe(201);
    const { trip } = await response.json() as { trip: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(trip, 'via')).toBe(false);
    const { trip: fetched } = await (await app.request(`/api/trips/${trip.id as string}`)).json() as { trip: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(fetched, 'via')).toBe(false);
  });
});
