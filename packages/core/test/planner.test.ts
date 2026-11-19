import { describe, expect, it } from 'vitest';
import { planTrip, PlanningError } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import { StatiqApiError } from '../src/statiq.js';
import type { Coords } from '../src/geo.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse, StatiqStationDetail, StatiqCharger } from '../src/types.js';

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
    detailsWithMeta: async (id: number) => ({
      response: {
        ok: true,
        live: true,
        retained: false,
        source: 'test',
        station: details.get(id) ?? null,
      },
      fetchedAt: new Date(),
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
    // 284.9 km * 175 Wh/km = 49.86 kWh of 71.25 usable -> ~30.0% arrival
    expect(plan.totals.finalSocPct).toBeGreaterThanOrEqual(29);
    expect(plan.totals.finalSocPct).toBeLessThanOrEqual(32);
    expect(plan.totals.totalTimeMin).toBeCloseTo(284.9, 0); // driving only
  });

  it('regression: explicit undefined option fields must not erase defaults', async () => {
    const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 900 + i,
      name: `Statiq U ${i}`,
      chainageKm: 50 * (i + 1),
    }));
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700), {
      startSocPct: undefined, // e.g. server clamp() returning undefined
      runBudget: undefined,
    });
    // start charge fell back to the 100% default, so stops are planned
    expect(plan.stops.length).toBe(2);
    expect(plan.stops[0]?.arriveSocPct).toBeGreaterThanOrEqual(25);
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
    // arrival SoC at stop 1 from 100% over ~300 km: ~26% (usable-based)
    expect(plan.stops[0]?.arriveSocPct).toBeGreaterThanOrEqual(25);
    expect(plan.stops[0]?.arriveSocPct).toBeLessThanOrEqual(28);
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

  it('carries the default vehicle meta with claimed and real-world range separate', async () => {
    const plan = await planTrip({ router: fakeRouter(284.9), statiq: fakeStatiq([]) }, O, D(284.9));
    expect(plan.vehicle.label).toContain('Harrier');
    expect(plan.vehicle.batteryKwh).toBe(75);
    expect(plan.vehicle.claimedRangeKm).toBe(627);
    expect(plan.vehicle.realWorldRangeKm).toBeNull();
  });

  it('stamps fetched-at times on every station view (memo honesty)', async () => {
    const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 300 + i,
      name: `Statiq T ${i}`,
      chainageKm: 50 * (i + 1),
    }));
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    for (const s of plan.stops) {
      const t = Date.parse(s.station.fetchedAt);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThan(Date.now() - 60_000);
    }
  });
});

describe('planTrip invariants (randomized worlds)', () => {
  // Deterministic PRNG so failures can be reproduced.
  function mulberry32(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('never plans an arrival below the minimum SoC, and legs stay within the cap', async () => {
    for (let seed = 1; seed <= 3; seed++) {
      const rnd = mulberry32(seed);
      const totalKm = 600 + Math.floor(rnd() * 600);
      // stations at random chainages with random small detours
      const stations: StationSpec[] = [];
      let ch = 30 + rnd() * 60;
      let id = 1;
      while (ch < totalKm - 10) {
        stations.push({
          id: id++,
          name: `S${id}`,
          chainageKm: ch,
          offRouteKm: rnd() < 0.8 ? 0 : rnd() * 3,
          kw: 50 + Math.floor(rnd() * 70),
          pricePerKwh: 15 + Math.round(rnd() * 10),
        });
        ch += 40 + rnd() * 80;
      }
      const plan = await planTrip({ router: fakeRouter(totalKm), statiq: fakeStatiq(stations) }, O, D(totalKm));
      const minArrival = 10;
      for (const s of plan.stops) {
        expect(s.arriveSocPct).toBeGreaterThanOrEqual(minArrival - 0.15);
        expect(s.leaveSocPct).toBeGreaterThanOrEqual(s.arriveSocPct);
        expect(s.legKm).toBeLessThanOrEqual(300 + 10); // 300 cap + detour slack
        expect(s.chargeKwh).toBeGreaterThanOrEqual(0);
      }
      // final arrival at destination also honors the minimum
      expect(plan.totals.finalSocPct).toBeGreaterThanOrEqual(minArrival - 1);
      // fewest-stops sanity: with 300 km legs, stop count is bounded
      expect(plan.stops.length).toBeLessThanOrEqual(Math.ceil(totalKm / 250) + 1);
    }
  });
});

describe('live details efficiency (lazy fallback band)', () => {
  it('fetches details only for primary-band stations until a window needs the fallback band', async () => {
    // primary-band stations at 0 km off-route every 50 km...
    const specs: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 600 + i,
      name: `Statiq Lazy ${i}`,
      chainageKm: 50 * (i + 1),
      offRouteKm: 0,
    }));
    // ...plus stations 3.5 km off-route (fallback band) that are never needed
    specs.push(
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 700 + i,
        name: `Offshore Stat ${i}`,
        chainageKm: 60 + i * 100,
        offRouteKm: 3.5,
      })),
    );
    let detailsCalls = 0;
    const base = fakeStatiq(specs);
    const counting = {
      ...base,
      detailsWithMeta: async (id: number) => {
        detailsCalls++;
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;

    const plan = await planTrip({ router: fakeRouter(700), statiq: counting }, O, D(700));
    // primary band was sufficient everywhere: fallback stations never fetched
    expect(detailsCalls).toBe(14);
    expect(plan.stops.every((s) => s.detourKm <= 2)).toBe(true);
  });

  it('lazily fetches the fallback band only when a window has no primary option', async () => {
    // gap in the primary band: only an off-route station can cover it
    const specs: StationSpec[] = [
      { id: 1, name: 'Statiq Near A', chainageKm: 100, offRouteKm: 0 },
      { id: 2, name: 'Statiq Offroute B', chainageKm: 390, offRouteKm: 3.2 },
      { id: 3, name: 'Statiq Near C', chainageKm: 600, offRouteKm: 0 },
    ];
    let detailsCalls = 0;
    const base = fakeStatiq(specs);
    const counting = {
      ...base,
      detailsWithMeta: async (id: number) => {
        detailsCalls++;
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;

    const plan = await planTrip({ router: fakeRouter(700), statiq: counting }, O, D(700));
    // all three stations fetched, the fallback one only when its window needed it
    expect(detailsCalls).toBe(3);
    expect(plan.stops.map((s) => s.station.name)).toContain('Statiq Offroute B');
    expect(plan.warnings.some((w) => w.includes('off-route'))).toBe(true);
  });
});

describe('fail-closed scan integrity', () => {
  const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
    id: 500 + i,
    name: `Statiq FC ${i}`,
    chainageKm: 50 * (i + 1),
  }));

  it('any 429-driven sample failure fails CLOSED as not_determined', async () => {
    const base = fakeStatiq(stations);
    const throttled = {
      ...base,
      markers: async (lat: number): Promise<StatiqMarkersResponse> => {
        // sample at ~km 180 throws 429; everything else succeeds
        const centerKm = lat * KM_PER_DEG;
        if (Math.abs(centerKm - 180) < 6) {
          throw new StatiqApiError(429, '/stations/markers', '{"error":"Please wait a minute."}');
        }
        return base.markers(lat, 0);
      },
    } as unknown as StatiqClient;
    const err = await planTrip({ router: fakeRouter(700), statiq: throttled }, O, D(700)).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code). not.toBe('infeasible');
    expect((err as PlanningError).code).toBe('not_determined');
  });

  it('isolated non-throttle failures degrade visibly instead of hiding', async () => {
    const base = fakeStatiq(stations);
    const flaky = {
      ...base,
      markers: async (lat: number): Promise<StatiqMarkersResponse> => {
        const centerKm = lat * KM_PER_DEG;
        if (Math.abs(centerKm - 180) < 6) {
          throw new StatiqApiError(500, '/stations/markers', 'boom');
        }
        return base.markers(lat, 0);
      },
    } as unknown as StatiqClient;
    const plan = await planTrip({ router: fakeRouter(700), statiq: flaky }, O, D(700));
    expect(plan.status).toBe('degraded');
    expect(plan.warnings.some((w) => w.includes('partial'))).toBe(true);
  });

  it('exceeding the upstream-call budget stops the run cleanly', async () => {
    // build a viable world, then strangle the budget below what it needs
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 3 } },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('budget-exhausted');
    // honest evidence, never a route-impossibility claim
    expect((err as PlanningError).message).toContain('3 upstream attempts');
  });

  it('deadline expiry cancels the run and reports an honest not_determined', async () => {
    // slow fake: every upstream call takes 30ms real time; deadline 40ms
    const base = fakeStatiq(stations);
    const slow = {
      ...base,
      markers: async (lat: number, lon: number, signal?: AbortSignal): Promise<StatiqMarkersResponse> => {
        await new Promise((r) => setTimeout(r, 30));
        if (signal?.aborted) throw new Error('This operation was aborted');
        return base.markers(lat, lon);
      },
    } as unknown as StatiqClient;
    const err = await planTrip(
      { router: fakeRouter(700), statiq: slow },
      O,
      D(700),
      { runBudget: { deadlineMs: 40, maxUpstreamCalls: 1_000 } },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('deadline');
  });
});
