import { describe, expect, it } from 'vitest';
import { planTrip, PlanningError } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse, StatiqStationDetail } from '../src/types.js';

// Same straight north-south fixture geometry as planner.test.ts: 1 deg lat
// = KM_PER_DEG km, so chainage == lat * KM_PER_DEG.
const KM_PER_DEG = 111.19492664455873;

function makeRoute(totalKm: number): RouteResult {
  const steps = Math.max(2, Math.ceil(totalKm / 5));
  const geometry = Array.from({ length: steps + 1 }, (_, i) => ({ lat: (totalKm * i / steps) / KM_PER_DEG, lon: 0 }));
  return { distanceKm: totalKm, durationMin: totalKm, geometry };
}
function router(totalKm: number): OsrmRouter {
  return {
    route: async (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => {
      const a = from.lat * KM_PER_DEG, b = to.lat * KM_PER_DEG;
      const km = Math.abs(b - a);
      const steps = Math.max(2, Math.ceil(km / 5));
      return { distanceKm: km, durationMin: km,
        geometry: Array.from({ length: steps + 1 }, (_, i) => ({ lat: (a + (b - a) * i / steps) / KM_PER_DEG, lon: 0 })) };
    },
  } as unknown as OsrmRouter;
}

interface Spec { id: number; km: number; off?: number; broken?: boolean; brand?: string; faultNote?: boolean }

function detail(s: Spec): StatiqStationDetail {
  const status = s.broken ? 'faulted' : 'available';
  return {
    stationId: s.id, name: `${s.brand ?? 'Statiq'} ${s.km}`, lat: s.km / KM_PER_DEG, lon: (s.off ?? 0) / KM_PER_DEG,
    address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59', openText: 'Open Now',
    rating: null, reviewCount: null, accessType: 'public', navUrl: '', stationUrl: '', imageUrl: null,
    amenities: [], stepsToReach: null, summary: null,
    chargers: [{ chargerId: s.id * 10, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20, currency: 'INR', lastUsedOn: null,
      connectors: [{ displayId: 1, connectorId: s.id * 100, type: 'CCS-2', status, available: !s.broken, note: s.faultNote ? 'Faulted' : null }] }],
  } as unknown as StatiqStationDetail;
}

function statiq(specs: Spec[]): { client: StatiqClient; looked: number[] } {
  const looked: number[] = [];
  const byId = new Map(specs.map((s) => [s.id, detail(s)]));
  const client = {
    markers: async (lat: number): Promise<StatiqMarkersResponse> => {
      const c = lat * KM_PER_DEG;
      const stations = specs.filter((s) => Math.abs(s.km - c) <= 13).map((s) => ({
        stationId: s.id, name: `${s.brand ?? 'Statiq'} ${s.km}`, lat: s.km / KM_PER_DEG, lon: (s.off ?? 0) / KM_PER_DEG,
        address: null, accessType: 1, isCommunityListed: false, stationUrl: '',
      }));
      return { ok: true, live: true, retained: false, source: 'test', count: stations.length, stations };
    },
    detailsWithMeta: async (id: number): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => {
      looked.push(id);
      return { response: { ok: true, live: true, retained: false, source: 'test', station: byId.get(id) ?? null }, fetchedAt: new Date() };
    },
  } as unknown as StatiqClient;
  return { client, looked };
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });
// Dense highway: a charger every 20 km.
const dense = (totalKm: number, extra: Partial<Spec> = {}): Spec[] =>
  Array.from({ length: Math.floor(totalKm / 20) - 1 }, (_, i) => ({ id: i + 1, km: (i + 1) * 20, ...extra }));

describe('smart search', () => {
  it('picks the same stops as thorough while checking far fewer chargers', async () => {
    const specs = dense(700);
    const thorough = statiq(specs);
    const smart = statiq(specs);
    const a = await planTrip({ router: router(700), statiq: thorough.client }, O, D(700), { searchMode: 'thorough' });
    const b = await planTrip({ router: router(700), statiq: smart.client }, O, D(700), { searchMode: 'smart' });
    expect(b.stops.map((s) => s.station.stationId)).toEqual(a.stops.map((s) => s.station.stationId));
    expect(b.totals).toEqual(a.totals);
    expect(thorough.looked.length).toBe(specs.length);
    expect(smart.looked.length).toBeLessThan(specs.length / 2);
    expect(b.search).toEqual({ mode: 'smart', candidatesFound: specs.length, candidatesChecked: smart.looked.length });
    expect(a.search).toMatchObject({ mode: 'thorough', candidatesChecked: specs.length });
  });

  it('never selects an unchecked station and skips broken ones it checked', async () => {
    // The farthest reachable chargers are broken; smart search must keep
    // looking further back and land on the farthest WORKING one.
    const specs = dense(500).map((s) => (s.km >= 240 && s.km <= 300 ? { ...s, broken: true } : s));
    const { client, looked } = statiq(specs);
    const plan = await planTrip({ router: router(500), statiq: client }, O, D(500), { searchMode: 'smart' });
    for (const stop of plan.stops) expect(looked).toContain(stop.station.stationId);
    expect(plan.stops[0]!.chainageKm).toBeLessThan(240);
    expect(specs.find((s) => s.id === plan.stops[0]!.station.stationId)?.broken).not.toBe(true);
  });

  it('reports infeasible only after checking every reachable candidate in the gap', async () => {
    const specs: Spec[] = [{ id: 1, km: 100, broken: true }, { id: 2, km: 200, broken: true }];
    const { client, looked } = statiq(specs);
    const err = await planTrip({ router: router(500), statiq: client }, O, D(500), { searchMode: 'smart' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('infeasible');
    expect(new Set(looked)).toEqual(new Set([1, 2]));
  });

  it('needs no lookups at all when the destination is reachable on the starting charge', async () => {
    const { client, looked } = statiq(dense(200));
    const plan = await planTrip({ router: router(200), statiq: client }, O, D(200), { searchMode: 'smart' });
    expect(plan.stops).toHaveLength(0);
    expect(looked).toHaveLength(0);
  });

  it('prefers on-route chargers before detours, matching thorough', async () => {
    const specs: Spec[] = [
      { id: 1, km: 290, off: 4 }, { id: 2, km: 270, off: 0.5 }, { id: 3, km: 150 },
    ];
    const s = statiq(specs);
    const t = statiq(specs);
    const smart = await planTrip({ router: router(450), statiq: s.client }, O, D(450), { searchMode: 'smart' });
    const thorough = await planTrip({ router: router(450), statiq: t.client }, O, D(450), { searchMode: 'thorough' });
    expect(smart.stops.map((x) => x.station.stationId)).toEqual(thorough.stops.map((x) => x.station.stationId));
    expect(smart.stops[0]!.station.stationId).toBe(2);
  });
});

describe('transport failures', () => {
  it('turns an unreachable routing service into an honest not_determined', async () => {
    const down = { route: async () => { throw new TypeError('fetch failed'); } } as unknown as OsrmRouter;
    const err = await planTrip({ router: down, statiq: statiq([]).client }, O, D(300)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect(err).toMatchObject({ code: 'not_determined', cause: 'network' });
    expect((err as Error).message).toMatch(/routing service|provider/);
  });

  it('keeps validation errors as validation errors', async () => {
    const err = await planTrip({ router: router(300), statiq: statiq([]).client }, O, D(300),
      { maxChargerKw: -1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RouterError', code: 'InvalidWaypoints' });
  });
});


describe('available status with a fault note (live Statiq pattern)', () => {
  for (const searchMode of ['smart', 'thorough'] as const) {
    it(`${searchMode}: plans through fault-noted chargers and warns on every such stop`, async () => {
      const specs = dense(700, { faultNote: true });
      const { client } = statiq(specs);
      const plan = await planTrip({ router: router(700), statiq: client }, O, D(700), { searchMode });
      expect(plan.stops.length).toBeGreaterThan(0);
      for (const stop of plan.stops) {
        expect(plan.warnings.some((w) => w.includes(`"${stop.station.name}"`) && /also reports a fault/.test(w))).toBe(true);
        expect(stop.station.chargers[0]?.plugs[0]).toMatchObject({
          health: 'uncertain', planningHealth: 'working-free', faultNote: 'positive_fault_with_available_status',
        });
      }
    });
  }

  it('does not warn on stops with clean plugs', async () => {
    const { client } = statiq(dense(700));
    const plan = await planTrip({ router: router(700), statiq: client }, O, D(700), { searchMode: 'smart' });
    expect(plan.warnings.some((w) => /also reports a fault/.test(w))).toBe(false);
  });
});
