import { describe, expect, it } from 'vitest';
import { planTrip, PlanningError } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import type { StatiqMarkersResponse, StatiqDetailsResponse, StatiqStationDetail, StatiqCharger } from '../src/types.js';

const KM_PER_DEG = 111.32;

/** Straight-line northwards route of the given length. */
function makeRoute(totalKm: number): RouteResult {
  const n = Math.max(2, Math.ceil(totalKm / 10));
  const geometry = Array.from({ length: n + 1 }, (_, i) => ({
    lat: (totalKm / KM_PER_DEG) * (i / n),
    lon: 0,
  }));
  return { distanceKm: totalKm, durationMin: totalKm, geometry }; // ~60 km/h
}

function fakeRouter(totalKm: number): OsrmRouter {
  return { route: async () => makeRoute(totalKm) } as unknown as OsrmRouter;
}

interface StationSpec {
  id: number;
  name: string;
  chainageKm: number;
  offRouteKm?: number;
  /** charger power in kW */
  kw?: number;
  pricePerKwh?: number | null;
  /** statuses of CCS2 DC plugs on its (single) DC charger; all-faulted means unusable */
  plugs?: Array<{ status: string; available: boolean | null; note: string | null }>;
  /** add an AC charger (must not affect CCS2 DC planning) */
  withAc?: boolean;
}

function stationDetail(spec: StationSpec): StatiqStationDetail {
  const dcPlugs = spec.plugs ?? [{ status: 'available', available: true, note: null }];
  const chargers: StatiqCharger[] = [
    {
      chargerId: spec.id * 10 + 1,
      name: `${spec.name} DC`,
      type: 'DC',
      kw: spec.kw ?? 60,
      pricePerKwh: spec.pricePerKwh ?? 20,
      currency: 'INR',
      lastUsedOn: '19/11/2026',
      connectors: dcPlugs.map((p, i) => ({
        displayId: i + 1,
        connectorId: spec.id * 100 + i,
        type: 'CCS-2',
        status: p.status,
        available: p.available,
        note: p.note,
      })),
    },
  ];
  if (spec.withAc) {
    chargers.push({
      chargerId: spec.id * 10 + 2,
      name: `${spec.name} AC`,
      type: 'AC',
      kw: 7.4,
      pricePerKwh: 12,
      currency: 'INR',
      lastUsedOn: null,
      connectors: [{ displayId: 1, connectorId: spec.id * 100 + 90, type: 'Type-2', status: 'available', available: true, note: null }],
    } as never);
  }
  return {
    stationId: spec.id,
    name: spec.name,
    lat: spec.chainageKm / KM_PER_DEG,
    lon: 0,
    address: null,
    area: null,
    city: null,
    landmark: null,
    hours: '00:00 To 23:59',
    openText: 'Open Now',
    rating: 4.0,
    reviewCount: 100,
    accessType: 'public',
    navUrl: '',
    stationUrl: '',
    imageUrl: null,
    amenities: [],
    stepsToReach: null,
    chargers,
    summary: null,
  };
}

function fakeStatiq(specs: StationSpec[]): StatiqClient {
  const details = new Map<number, StatiqStationDetail>(specs.map((s) => [s.id, stationDetail(s)]));
  const detoured = (s: StationSpec) => s.offRouteKm ?? 0;
  return {
    markers: async (lat: number): Promise<StatiqMarkersResponse> => {
      const centerKm = lat * KM_PER_DEG;
      const stations = specs
        .filter((s) => Math.abs(s.chainageKm - centerKm) <= 13)
        .map((s) => {
          const st = details.get(s.id) as StatiqStationDetail;
          // offset perpendicular: lon shift approximates the off-route km
          return {
            stationId: s.id,
            name: s.name,
            lat: st.lat,
            lon: detoured(s) / KM_PER_DEG,
            address: null,
            accessType: 1,
            isCommunityListed: false,
            stationUrl: '',
          };
        });
      return { ok: true, live: true, retained: false, source: 'test', count: stations.length, stations };
    },
    details: async (id: number): Promise<StatiqDetailsResponse> => ({
      ok: true,
      live: true,
      retained: false,
      source: 'test',
      station: details.get(id) ?? null,
    }),
  } as unknown as StatiqClient;
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });

describe('planTrip', () => {
  it('a ~285 km trip from 100% needs no stops (Delhi->Jaipur profile)', async () => {
    const statiq = fakeStatiq([]);
    const plan = await planTrip({ router: fakeRouter(284.9), statiq }, O, D(284.9));
    expect(plan.stops).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
    expect(plan.routeDistanceKm).toBeCloseTo(284.9, 1);
    // 284.9 km * 175 Wh/km = 49.9 kWh of 75 -> ~33.4% arrival
    expect(plan.totals.finalSocPct).toBeGreaterThanOrEqual(32);
    expect(plan.totals.finalSocPct).toBeLessThanOrEqual(35);
    expect(plan.totals.totalTimeMin).toBeCloseTo(284.9, 0); // driving only
  });

  it('long routes take fewest stops with 250-300 km legs', async () => {
    const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 100 + i,
      name: `Statiq Station ${i}`,
      chainageKm: 50 * (i + 1),
    }));
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    // legs: 300 -> 300 -> 100 remaining: exactly 2 stops
    // (synthetic geometry via 111.32 km/deg shifts chainage ~0.3-0.7 km)
    expect(plan.stops).toHaveLength(2);
    expect(plan.stops[0]?.chainageKm).toBeGreaterThan(297);
    expect(plan.stops[0]?.chainageKm).toBeLessThan(301);
    expect(plan.stops[1]?.chainageKm).toBeGreaterThan(597);
    expect(plan.stops[1]?.chainageKm).toBeLessThan(601);
    // arrival SoC at stop 1 from 100% over ~300 km: ~30%
    expect(plan.stops[0]?.arriveSocPct).toBeGreaterThanOrEqual(29);
    expect(plan.stops[0]?.arriveSocPct).toBeLessThanOrEqual(31);
    // stop 2 arrives at the minimal-charge buffer (~12%)
    expect(Math.round(plan.stops[1]?.arriveSocPct ?? 0)).toBe(12);
    // charging numbers exist and are positive
    for (const s of plan.stops) {
      expect(s.chargeKwh).toBeGreaterThan(0);
      expect(s.estPriceInr).toBeGreaterThan(0);
      expect(s.chargeTimeMin).toBeGreaterThan(0);
      expect(s.pricePerKwh).toBe(20);
    }
    // brand bias-free world: all statiq labels
    expect(plan.stops.every((s) => s.station.brand === 'statiq')).toBe(true);
    // totals consistent
    expect(plan.totals.chargeTimeMin).toBeCloseTo(
      plan.stops.reduce((a, s) => a + s.chargeTimeMin, 0),
      0,
    );
    expect(plan.totals.estPriceInr).toBeCloseTo(
      plan.stops.reduce((a, s) => a + (s.estPriceInr ?? 0), 0),
      0,
    );
    expect(plan.stationsSeen).toBe(14);
  });

  it('brand preference breaks ties inside the cluster without costing a stop', async () => {
    const stations: StationSpec[] = [
      { id: 1, name: 'Statiq Classic', chainageKm: 280 },
      { id: 2, name: 'Zeon Charging Point', chainageKm: 285, kw: 120, pricePerKwh: 18 },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 10 + i,
        name: `Statiq Station ${i}`,
        chainageKm: 350 + 50 * i,
      })),
    ];
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    expect(plan.stops[0]?.station.name).toBe('Statiq Classic');
    // same stop count as the unbiased case
    expect(plan.stops).toHaveLength(2);
  });

  it('skips stations whose CCS2 plugs are all faulted or contradictory', async () => {
    const stations: StationSpec[] = [
      {
        id: 1,
        name: 'Broken Statiq',
        chainageKm: 100,
        plugs: [
          { status: 'faulted', available: false, note: 'Faulted' },
          { status: 'available', available: true, note: 'Faulted' }, // contradiction -> uncertain
        ],
      },
      { id: 2, name: 'Working Statiq', chainageKm: 290, plugs: [{ status: 'charging', available: false, note: 'Charging' }] },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, name: `Statiq Station ${i}`, chainageKm: 350 + 50 * i })),
    ];
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    expect(plan.stops[0]?.station.name).toBe('Working Statiq');
    expect(plan.stops[0]?.arriveSocPct).toBeGreaterThanOrEqual(10);
  });

  it('keeps occupied CCS2 plugs as usable stops', async () => {
    const stations: StationSpec[] = [
      {
        id: 1,
        name: 'Busy Statiq',
        chainageKm: 290,
        plugs: [
          { status: 'charging', available: false, note: 'Charging' },
          { status: 'charging', available: false, note: 'Charging' },
        ],
      },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, name: `Statiq Station ${i}`, chainageKm: 350 + 50 * i })),
    ];
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    expect(plan.stops.map((s) => s.station.name)).toContain('Busy Statiq');
  });

  it('falls back to off-route stations only when the primary band is empty', async () => {
    const stations: StationSpec[] = [
      { id: 1, name: 'Statiq Offroad', chainageKm: 280, offRouteKm: 3 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, name: `Statiq Station ${i}`, chainageKm: 350 + 50 * i })),
    ];
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    expect(plan.stops[0]?.station.name).toBe('Statiq Offroad');
    expect(plan.stops[0]?.detourKm).toBeGreaterThan(2.5);
    expect(plan.warnings.some((w) => w.includes('off-route'))).toBe(true);
  });

  it('throws a clear error when the gap exceeds 300 km', async () => {
    const stations: StationSpec[] = [
      { id: 1, name: 'Statiq Far', chainageKm: 350 },
      { id: 2, name: 'Statiq Farther', chainageKm: 680 },
    ];
    await expect(
      planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700)),
    ).rejects.toThrowError(PlanningError);
  });

  it('reports per-stop arrive/leave SoC, tariff, price and time', async () => {
    const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 200 + i,
      name: `Statiq Priced ${i}`,
      chainageKm: 50 * (i + 1),
      kw: 120,
      pricePerKwh: 22.5,
    }));
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    const s0 = plan.stops[0];
    expect(s0).toBeDefined();
    expect(s0?.arriveSocPct).toBeLessThan(s0?.leaveSocPct ?? 0);
    expect(s0?.pricePerKwh).toBe(22.5);
    // charged kWh * tariff ~= price (kWh is reported to 1 decimal)
    expect(Math.abs((s0?.estPriceInr ?? 0) - (s0?.chargeKwh ?? 0) * 22.5)).toBeLessThanOrEqual(3);
    expect(s0?.chargeTimeMin).toBeGreaterThan(5);
    // ETA ordering: departure after arrival, later stops later in time
    expect(s0?.departureEtaMin).toBeGreaterThan(s0?.arrivalEtaMin ?? 0);
    const s1 = plan.stops[1];
    expect((s1?.arrivalEtaMin ?? 0)).toBeGreaterThan((s0?.departureEtaMin ?? 0));
  });
});
