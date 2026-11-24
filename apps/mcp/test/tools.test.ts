import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  StatiqClient,
  TripsStore,
  type TripPlan,
  type RouteResult,
  type StatiqDetailsResponse,
  type StatiqMarkersResponse,
  type StatiqStationDetail,
} from '@indeev/core';
import {
  getStationHandler,
  planToStructured,
  listSavedTripsHandler,
  planTripHandler,
  type McpToolDeps,
} from '../src/tools.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDeps(overrides: Partial<McpToolDeps> = {}): Promise<McpToolDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-mcp-test-'));
  tempDirs.push(dir);
  return {
    createStatiq: () => new StatiqClient({ token: 't', minCallGapMs: 1, maxCallsPerMinute: 1_000 }),
    router: endpointRouter() as unknown as OsrmRouter,
    geocoder: {
      search: async (q: string) => [
        { name: q, label: `${q}, India`, lat: 28.6, lon: 77.2, city: 'Delhi', state: 'Delhi', country: 'India' },
      ],
    } as unknown as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'saved-trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    ...overrides,
  };
}

function liveStatiqFake() {
  return {
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
}

describe('plan_trip handler', () => {
  it('uses an explicit real-world range for the default vehicle even without a catalog id', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const result = await planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur', vehicleRealWorldRangeKm: 450 });
    expect(result.plan.vehicle.realWorldRangeKm).toBe(450);
    expect(result.plan.vehicle.catalogId).toBe('tata-harrier-ev-75');
  });

  it('retains custom vehicle claimed range in km separately from real-world range', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const args = { origin: 'Delhi', destination: 'Jaipur', customVehicle: {
      label: 'Custom fixture', batteryKwh: 60, claimedRangeKm: 500, realWorldRangeKm: 350,
    } };
    const result = await planTripHandler(deps, args);
    expect(result.plan.vehicle.claimedRangeKm).toBe(500);
    expect(result.plan.vehicle.realWorldRangeKm).toBe(350);
  });

  it('delivers and saves a valid plan with an explicit warning when counter telemetry fails', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake(), counters: { addChargersSeen: async () => { throw new Error('counter corrupt'); } } as unknown as CountersStore });
    const result = await planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur', save: 'Counter warning fixture' });
    expect(result.plan.source).toBe('live');
    expect(result.summary).toContain('not added to the saved running count');
    expect(result.savedTripId).toBeTruthy();
    expect((await deps.trips.list())).toHaveLength(1);
  });

  it('plans a route, accepts "lat,lon" origins, and saves when asked', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    // 300 km route, no stations needed from full charge
    const result = await planTripHandler(deps, {
      origin: '28.6139,77.2090',
      destination: 'Jaipur',
      save: 'Work trip',
    });
    expect(result.plan.stops).toHaveLength(0);
    expect(result.plan.origin.label).toContain('28.6139');
    expect(result.plan.vehicle.label).toContain('Harrier');
    expect(result.savedTripId).toBeTruthy();

    const list = await listSavedTripsHandler(deps);
    expect(list.count).toBe(1);
    expect(list.trips[0]?.source).toBe('live');
    expect(list.trips[0]?.name).toBe('Work trip');
  });

  it('rejects non-default vehicles without a user-provided real-world range', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    await expect(
      planTripHandler(deps, {
        origin: 'Delhi',
        destination: 'Jaipur',
        vehicleCatalogId: 'tata-nexon-ev-lr-45',
        // realWorldRangeKm omitted: manufacturer claims must never stand in
      }),
    ).rejects.toThrow(/real-world range/i);
  });

  it('fails closed in mock mode (no synthetic planner in MCP)', async () => {
    const deps = await makeDeps({ mock: true });
    await expect(
      planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur' }),
    ).rejects.toThrow(/mock mode/i);
  });
});

describe('get_station handler (AI-safe)', () => {
  it.each([
    [['31/10/2026', '01/11/2026'], '01/11/2026'],
    [['31/12/2025', '01/01/2026'], '01/01/2026'],
    [['31/02/2026', '28/02/2026'], '28/02/2026'],
    [[null, null], null],
    [['unknown', 'not recorded'], 'unknown'],
    [['unknown', '29/02/2024', '01/03/2024'], '01/03/2024'],
  ])('uses calendar chronology for last-used values %j', async (dates, expected) => {
    const station = { stationId: 42, name: 'Fixture', chargers: dates.map(lastUsedOn => ({ type: 'DC', connectors: [], lastUsedOn })) };
    const statiq = { detailsWithMeta: async () => ({ response: { ok: true, station }, fetchedAt: new Date() }) } as unknown as StatiqClient;
    const result = await getStationHandler(await makeDeps({ createStatiq: () => statiq }), 42);
    expect(result.station.lastUsedOn).toBe(expected);
  });

  it.each(['wrong-id', 'not-ok', 'missing-chargers', 'null-chargers', 'missing-connectors', 'null-connectors'] as const)('rejects %s station evidence rather than reporting live availability', async (kind) => {
    let calls = 0;
    const station = { stationId: kind === 'wrong-id' ? 43 : 42, name: 'Fixture', chargers: [{ type: 'DC', connectors: [] }] };
    if (kind.endsWith('chargers')) Object.assign(station, { chargers: kind === 'null-chargers' ? null : undefined });
    if (kind.endsWith('connectors')) Object.assign(station.chargers[0]!, { connectors: kind === 'null-connectors' ? null : undefined });
    const statiq = {
      detailsWithMeta: async () => { calls++; return { response: { ok: kind !== 'not-ok', station }, fetchedAt: new Date() }; },
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    await expect(getStationHandler(deps, 42)).rejects.toMatchObject({ code: 'not_determined' });
    expect(calls).toBe(1);
  });

  it.each(['empty-chargers', 'empty-connectors'] as const)('preserves %s as valid known-empty evidence', async (kind) => {
    const station = { stationId: 42, name: 'Fixture', chargers: kind === 'empty-chargers' ? [] : [{ type: 'DC', connectors: [] }] };
    const statiq = { detailsWithMeta: async () => ({ response: { ok: true, station }, fetchedAt: new Date() }) } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });
    const result = await getStationHandler(deps, 42);
    expect(result.station.stationId).toBe(42);
    expect(result.station.ccs2Usable).toBe(0);
  });

  it('blocks station lookups in mock mode before creating a live client', async () => {
    let created = 0;
    const deps = await makeDeps({ mock: true, createStatiq: () => { created++; return liveStatiqFake(); } });
    await expect(getStationHandler(deps, 42)).rejects.toThrow(/mock mode/i);
    expect(created).toBe(0);
  });

  it('reports usable plugs WITHOUT occupancy and keeps honesty counters', async () => {
    const fetchedAt = new Date('2026-11-19T12:00:00Z');
    const statiq = {
      detailsWithMeta: async (): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
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
                name: 'DC 120',
                type: 'DC',
                kw: 120,
                pricePerKwh: 22.75,
                currency: 'INR',
                lastUsedOn: '19/11/2026',
                connectors: [
                  // one occupied-but-working plug and one free plug
                  { displayId: 1, connectorId: 11, type: 'CCS-2', status: 'charging', available: false, note: 'Charging' },
                  { displayId: 2, connectorId: 12, type: 'CCS-2', status: 'available', available: true, note: null },
                  // available status vs fault note: observed uncertain, planned as usable (warned)
                  { displayId: 3, connectorId: 13, type: 'CCS-2', status: 'available', available: true, note: 'Faulted' },
                ],
              },
            ],
            summary: null,
          } as StatiqStationDetail,
        },
        fetchedAt,
      }),
    } as unknown as StatiqClient;
    const deps = await makeDeps({ createStatiq: () => statiq });

    const { station, summary } = await getStationHandler(deps, 1790);
    expect(station.ccs2Usable).toBe(3); // occupied and fault-noted available count as usable
    expect(station.ccs2Uncertain).toBe(1);
    expect(station.ccs2FaultNoted).toBe(1);
    expect(summary).toContain('1 usable plug(s) also carry a fault note');
    expect(station.reliability).toBeNull();
    expect(station.fetchedAt).toBe('2026-11-19T12:00:00.000Z');
    // NEVER occupancy: no free/occupied/charging vocabulary anywhere
    expect(JSON.stringify(station)).not.toMatch(/occupied|"free"|charging/i);
    expect(summary).toContain('usable CCS2 DC plug(s)');
    expect(summary).toContain('reliability unavailable');
  });

  it('throws for unknown stations', async () => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    await expect(getStationHandler(deps, 42)).rejects.toThrow(/not found/i);
  });
});

describe('list_saved_trips handler (shared store)', () => {
  it('sees trips saved by the website (same file semantics), minimal refs only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'indeev-mcp-shared-'));
    tempDirs.push(dir);
    const storePath = join(dir, 'saved-trips.json');
    const webStore = new TripsStore({ filePath: storePath });
    await webStore.save({
      id: 'web-1',
      createdAt: new Date().toISOString(),
      origin: { label: 'Delhi', lat: 28.6, lon: 77.2 },
      destination: { label: 'Agra', lat: 27.17, lon: 78.01 },
      vehicle: {
        label: 'Tata Harrier EV (75 kWh)',
        catalogId: 'tata-harrier-ev-75',
        batteryKwh: 75,
        claimedRangeKm: 627,
        realWorldRangeKm: null,
      },
      status: 'ok',
      source: 'live',
      routeDistanceKm: 230,
      routeDurationMin: 220,
      geometry: [[28.6, 77.2]],
      stations: [],
      totals: {
        distanceKm: 230,
        driveTimeMin: 220,
        chargeTimeMin: 0,
        totalTimeMin: 220,
        chargeKwh: 0,
        estPriceInr: null,
        finalSocPct: 40,
      },
      warnings: [],
      stops: [],
    } as never);

    const deps = await makeDeps({ trips: new TripsStore({ filePath: storePath }) });
    const list = await listSavedTripsHandler(deps);
    expect(list.count).toBe(1);
    expect(list.trips[0]?.id).toBe('web-1');

    // minimal refs only: no station detail data persisted
    const raw = JSON.parse(await readFile(storePath, 'utf8')) as unknown[];
    const rawJson = JSON.stringify(raw);
    expect(rawJson).not.toContain('rating');
    expect(rawJson).not.toContain('chargers');
    expect(rawJson).not.toContain('reliability');
  });
});

describe('structured plan last-used dates', () => {
  it.each([
    [['31/10/2026', '01/11/2026'], '01/11/2026'],
    [['31/12/2025', '01/01/2026'], '01/01/2026'],
    [['unknown', '28/02/2026', '31/02/2026'], '28/02/2026'],
    [[null, null], null],
  ])('uses the same latest-date evidence as station summaries for %j', (dates, expected) => {
    const plan = {
      id: 'fixture', origin: {}, destination: {}, geometry: [], totals: {}, warnings: [],
      stops: [{ station: { stationId: 42, name: 'Fixture', chargers: dates.map(lastUsedOn => ({ lastUsedOn })) } }],
    } as unknown as TripPlan;
    const result = planToStructured(plan) as { stops: Array<{ lastUsedOn: string | null }> };
    expect(result.stops[0]!.lastUsedOn).toBe(expected);
  });
});

it('returns the actual saved trip ID and warnings after successful MCP save with cleanup failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indev-mcp-lock-')); tempDirs.push(dir);
  const path = join(dir, 'saved-trips.json');
  const deps = await makeDeps({ createStatiq: () => liveStatiqFake(), trips: new TripsStore({ filePath: path }) });
  const spy = vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup refusal'));
  try {
    const result = await planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur', save: 'Saved once' });
    expect(result.savedTripId).toBeTruthy();
    expect(result.summary).toContain('Storage operation completed');
    expect(result.summary).toContain('Do not retry');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe(result.savedTripId);
    expect(result.plan.warnings.join(' ')).toContain('persistence could not be confirmed');
    expect((await deps.counters.load()).chargersSeen).toBe(result.plan.stationsSeen);
  } finally { spy.mockRestore(); }
});

it.each([{ live: false }, { retained: true }, { live: 'true' }, { retained: null }])('MCP refresh refuses nonfresh envelope %j before not-found or live view', async evidence => {
  const statiq = { detailsWithMeta: async () => ({ response: { ok: true, station: null, ...evidence }, fetchedAt: new Date() }) } as unknown as StatiqClient;
  const deps = await makeDeps({ createStatiq: () => statiq });
  await expect(getStationHandler(deps, 42)).rejects.toMatchObject({ code: 'not_determined' });
});

it('MCP refresh maps real-client nonfresh evidence to no-verdict, not absent station', async () => {
  let calls = 0;
  const deps = await makeDeps({ createStatiq: () => new StatiqClient({ token: 'offline-only', retries: 2, fetchImpl: (async () => {
    calls++; return new Response(JSON.stringify({ ok: true, live: false, retained: true, station: null }));
  }) as typeof fetch }) });
  await expect(getStationHandler(deps, 42)).rejects.toMatchObject({ code: 'not_determined' }); expect(calls).toBe(1);
});
describe('MCP ordered stopovers', () => {
  type Place = { label: string; lat: number; lon: number };
  type RouteCall = { origin: Place; destination: Place; via: readonly Place[] };
  // Stopovers must sit ON the certified road geometry and in forward order
  // (route-legs certification), so fixture places lie along the Delhi ->
  // Jaipur line at fixed fractions instead of all sharing one coordinate.
  const START = { lat: 28.6, lon: 77.2 };
  const END = { lat: 26.9, lon: 75.8 };
  const FRACTION: Record<string, number> = {
    Delhi: 0, Jaipur: 1, Nagpur: 0.1, A: 0.2, Indore: 0.25, Ahmedabad: 0.4, Surat: 0.55, B: 0.6, Vapi: 0.7,
  };
  function coordsFor(query: string): { lat: number; lon: number } {
    const f = FRACTION[query];
    if (f === undefined) throw new Error(`fixture has no position for ${query}`);
    return { lat: START.lat + (END.lat - START.lat) * f, lon: START.lon + (END.lon - START.lon) * f };
  }
  function place(query: string): Place {
    return { label: `${query}, India`, ...coordsFor(query) };
  }
  function hit(query: string): Record<string, unknown> {
    return { name: query, ...place(query), city: null, state: null, country: 'India' };
  }
  function routeResult(): RouteResult {
    return { distanceKm: 300, durationMin: 300, geometry: [START, END] };
  }

  const malformed = [
    { name: 'null', via: null },
    { name: 'object', via: { label: 'A', lat: 23, lon: 72 } },
    { name: 'string', via: 'Jaipur' },
    { name: 'six stops', via: Array.from({ length: 6 }, (_, i) => `Stop ${i}`) },
    { name: 'blank query', via: ['Delhi', '   '] },
    { name: 'wrong member type', via: [42] },
    { name: 'sparse array', via: new Array(2) },
  ];
  it.each(malformed)('rejects runtime malformed via before external calls: $name', async ({ via }) => {
    let geocodeCalls = 0;
    let routeCalls = 0;
    let providerCalls = 0;
    const deps = await makeDeps({
      createStatiq: () => { providerCalls += 1; return liveStatiqFake(); },
      geocoder: { search: async (q: string) => { geocodeCalls += 1; return [hit(q)] as never; } } as unknown as PhotonGeocoder,
      router: { route: async (): Promise<RouteResult> => { routeCalls += 1; return routeResult(); } } as unknown as OsrmRouter,
    });
    const args = { origin: 'Delhi', destination: 'Jaipur', via } as unknown as Parameters<typeof planTripHandler>[1];
    await expect(planTripHandler(deps, args)).rejects.toMatchObject({ code: 'no_route' });
    expect({ geocodeCalls, routeCalls, providerCalls }).toEqual({ geocodeCalls: 0, routeCalls: 0, providerCalls: 0 });
  });

  const stopoverSets = [
    { name: 'one', queries: ['Ahmedabad'] },
    { name: 'five', queries: ['Nagpur', 'Indore', 'Ahmedabad', 'Surat', 'Vapi'] },
  ];
  it.each(stopoverSets)('resolves $name ordered stopovers into one full route', async ({ queries }) => {
    const searchQueries: string[] = [];
    const routeCalls: RouteCall[] = [];
    let providerCalls = 0;
    const deps = await makeDeps({
      createStatiq: () => { providerCalls += 1; return liveStatiqFake(); },
      geocoder: { search: async (q: string) => { searchQueries.push(q); return [hit(q)] as never; } } as unknown as PhotonGeocoder,
      router: {
        route: async (
          origin: Place,
          destination: Place,
          _signal: AbortSignal | undefined,
          via: readonly Place[] = [],
        ): Promise<RouteResult> => {
          routeCalls.push({ origin, destination, via });
          return routeResult();
        },
      } as unknown as OsrmRouter,
    });
    const result = await planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur', via: queries });
    expect(searchQueries).toEqual(['Delhi', 'Jaipur', ...queries]);
    expect(providerCalls).toBe(1);
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.origin).toEqual(place('Delhi'));
    expect(routeCalls[0]?.destination).toEqual(place('Jaipur'));
    const expected = queries.map(place);
    expect(routeCalls[0]?.via).toEqual(expected);
    expect(result.plan.via).toEqual(expected);
    expect(result.plan.geometry).toEqual(routeResult().geometry);
    expect(result.summary).toContain(`User stopovers, in route order: ${expected.map(place => place.label).join(' -> ')}`);
  });

  it('copies string inputs before the first geocode await', async () => {
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let first = true;
    const searchQueries: string[] = [];
    const routeCalls: RouteCall[] = [];
    const deps = await makeDeps({
      createStatiq: () => liveStatiqFake(),
      geocoder: {
        search: async (q: string) => {
          searchQueries.push(q);
          if (first) { first = false; firstStarted(); await gate; }
          return [hit(q)] as never;
        },
      } as unknown as PhotonGeocoder,
      router: {
        route: async (
          origin: Place,
          destination: Place,
          _signal: AbortSignal | undefined,
          via: readonly Place[] = [],
        ): Promise<RouteResult> => {
          routeCalls.push({ origin, destination, via });
          return routeResult();
        },
      } as unknown as OsrmRouter,
    });
    const args = { origin: 'Delhi', destination: 'Jaipur', via: ['A', 'B'], save: 'Saved before await' };
    const pending = planTripHandler(deps, args);
    try {
      await started;
      args.origin = 'Mutated origin';
      args.destination = 'Mutated destination';
      args.via[0] = 'Mutated A';
      args.via.push('Extra');
      args.save = 'Mutated save';
    } finally {
      releaseFirst();
    }
    const result = await pending;
    expect(searchQueries).toEqual(['Delhi', 'Jaipur', 'A', 'B']);
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.origin.label).toBe('Delhi, India');
    expect(routeCalls[0]?.destination.label).toBe('Jaipur, India');
    expect(routeCalls[0]?.via.map(place => place.label)).toEqual(['A, India', 'B, India']);
    expect(result.plan.via?.map(place => place.label)).toEqual(['A, India', 'B, India']);
    expect((await deps.trips.list())[0]?.name).toBe('Saved before await');
  });

  it('saves exact plain stopovers in results, structured output and the shared store', async () => {
    const queries = ['Nagpur', 'Indore', 'Ahmedabad', 'Surat', 'Vapi'];
    const deps = await makeDeps({
      createStatiq: () => liveStatiqFake(),
      geocoder: { search: async (q: string) => [hit(q)] } as unknown as PhotonGeocoder,
    });
    const result = await planTripHandler(deps, { origin: 'Delhi', destination: 'Jaipur', via: queries, save: 'Via save' });
    const expected = queries.map(place);
    expect(result.plan.via).toEqual(expected);
    const structured = planToStructured(result.plan) as { via?: unknown };
    expect(structured.via).toEqual(expected);
    const saved = (await deps.trips.list())[0] as unknown as Record<string, unknown>;
    expect(saved.via).toEqual(expected);
    for (const place of (saved.via as Array<Record<string, unknown>>)) {
      expect(Object.keys(place).sort()).toEqual(['label', 'lat', 'lon']);
    }
  });

  it.each([
    { name: 'omitted', via: undefined },
    { name: 'empty', via: [] as string[] },
  ])('preserves A-B behavior and summary with $name via', async ({ via }) => {
    const deps = await makeDeps({ createStatiq: () => liveStatiqFake() });
    const args = { origin: 'Delhi', destination: 'Jaipur', ...(via === undefined ? {} : { via }) };
    const result = await planTripHandler(deps, args);
    expect(Object.prototype.hasOwnProperty.call(result.plan, 'via')).toBe(false);
    expect(result.summary.startsWith('Delhi, India -> Jaipur, India:')).toBe(true);
    expect(result.summary).not.toContain('User stopovers');
  });
});
