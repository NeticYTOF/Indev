import { describe, expect, it } from 'vitest';
import { planTrip, PlanningError } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import { StatiqApiError } from '../src/statiq.js';
import { resolveVehicle } from '../src/vehicle-catalog.js';
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
  it('does not bypass the 300 km hard gap when starting energy could cover 350 km', async () => {
    const plan = await planTrip({ router: fakeRouter(350), statiq: fakeStatiq([
      { id: 1, name: 'Statiq 200', chainageKm: 200 },
    ]) }, O, D(350));
    expect(plan.stops).toHaveLength(1);
    expect(plan.stops[0]!.legKm).toBeLessThanOrEqual(300);
    expect(plan.routeDistanceKm - plan.stops[0]!.chainageKm).toBeLessThanOrEqual(300);
  });

  it('reports the tightened ceiling in infeasible evidence with production vehicle wiring', async () => {
    const resolvedVehicle = resolveVehicle({
      custom: { label: 'Short-range test car', batteryKwh: 60, realWorldRangeKm: 150 },
    });
    // Production HTTP/MCP pass both the derived config and its metadata.
    // The matched 150 km config already makes 200 km energy-infeasible;
    // this pins diagnostic provenance, not a new safety rejection.
    const err = await planTrip(
      {
        router: fakeRouter(200),
        statiq: fakeStatiq([{ id: 1, name: 'Statiq 200', chainageKm: 200 }]),
        vehicle: resolvedVehicle.config,
        resolvedVehicle,
      },
      O,
      D(200),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'infeasible' });
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/150 km safe running range/);
    expect(message).not.toMatch(/300 km safe running range/);
  });

  it('adds a stop when an energy-reachable final hop still exceeds 300 km', async () => {
    const plan = await planTrip({ router: fakeRouter(640), statiq: fakeStatiq([
      { id: 1, name: 'Statiq 300', chainageKm: 300 },
      { id: 2, name: 'Statiq 550', chainageKm: 550 },
    ]) }, O, D(640));
    expect(plan.stops).toHaveLength(2);
    const last = plan.stops.at(-1)!;
    expect(plan.routeDistanceKm - last.chainageKm + last.detourKm).toBeLessThanOrEqual(300);
  });

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

  it.each([1.5, 3])('includes leaving and rejoining every stop in trip time (%s km off route)', async (offRouteKm) => {
    const stations: StationSpec[] = [
      { id: 1, name: 'Statiq Offroad', chainageKm: 280, offRouteKm },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, name: `Statiq Station ${i}`, chainageKm: 350 + 50 * i, offRouteKm })),
    ];
    const plan = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(stations) }, O, D(700));
    expect(plan.stops.length).toBeGreaterThan(1);
    const roundTripDetours = 2 * plan.stops.reduce((sum, stop) => sum + stop.detourKm, 0);
    expect(roundTripDetours).toBeGreaterThan(5);
    // Fixture routing has one driving minute per km. Off-route distances
    // already enter individual leg ETAs and must also enter trip totals.
    expect(plan.totals.driveTimeMin).toBe(Math.round(700 + roundTripDetours));
    expect(plan.totals.totalTimeMin).toBe(plan.totals.driveTimeMin + plan.totals.chargeTimeMin);
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

describe('station details identity integrity', () => {
  it.each(['empty-chargers', 'empty-connectors'] as const)('preserves explicit %s as known-empty data', async (kind) => {
    const specs: StationSpec[] = [{ id: 1, name: 'Statiq Empty', chainageKm: 100 }];
    const base = fakeStatiq(specs);
    const empty = {
      ...base,
      detailsWithMeta: async (id: number) => {
        const result = await base.detailsWithMeta(id);
        if (kind === 'empty-chargers') result.response.station!.chargers = [];
        else result.response.station!.chargers[0]!.connectors = [];
        return result;
      },
    } as unknown as StatiqClient;
    const err = await planTrip({ router: fakeRouter(700), statiq: empty }, O, D(700)).catch(e => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('no_route');
  });

  it.each(['missing-chargers', 'null-chargers', 'missing-connectors', 'null-connectors'] as const)('keeps %s detail evidence unknown, not known-unusable', async (kind) => {
    const specs: StationSpec[] = [{ id: 1, name: 'Statiq Incomplete', chainageKm: 100 }];
    const base = fakeStatiq(specs);
    const incomplete = {
      ...base,
      detailsWithMeta: async (id: number) => {
        const result = await base.detailsWithMeta(id);
        const station = result.response.station!;
        if (kind.endsWith('chargers')) {
          Object.assign(station, { chargers: kind === 'null-chargers' ? null : undefined });
        } else {
          Object.assign(station.chargers[0]!, { connectors: kind === 'null-connectors' ? null : undefined });
        }
        return result;
      },
    } as unknown as StatiqClient;
    const err = await planTrip({ router: fakeRouter(700), statiq: incomplete }, O, D(700)).catch(e => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('candidate-holes');
  });

  it.each(['wrong-id', 'not-ok'] as const)('does not attach %s details to a corridor station', async (kind) => {
    const specs: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 900 + i, name: `Statiq Identity ${i}`, chainageKm: 50 * (i + 1),
    }));
    const base = fakeStatiq(specs);
    const fetchedIds: number[] = [];
    const mismatched = {
      ...base,
      detailsWithMeta: async (id: number) => {
        fetchedIds.push(id);
        const result = await base.detailsWithMeta(id);
        return {
          ...result,
          response: {
            ...result.response,
            ok: kind !== 'not-ok',
            station: { ...result.response.station!, stationId: kind === 'wrong-id' ? id + 1000 : id },
          },
        };
      },
    } as unknown as StatiqClient;
    const err = await planTrip({ router: fakeRouter(700), statiq: mismatched }, O, D(700)).catch(e => e);
    expect(fetchedIds).toHaveLength(14);
    expect(new Set(fetchedIds).size).toBe(14);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
  });
});

describe('live details exhaustiveness (whole-batch candidate fetch)', () => {
  it('fetches details for EVERY candidate in both detour bands, each exactly once', async () => {
    // primary-band stations at 0 km off-route every 50 km...
    const specs: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 600 + i,
      name: `Statiq Primary ${i}`,
      chainageKm: 50 * (i + 1),
      offRouteKm: 0,
    }));
    // ...plus fallback-band stations 3.5 km off-route that are never needed
    // for any stop: exhaustive coverage (owner directive) still fetches them.
    specs.push(
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 700 + i,
        name: `Offshore Stat ${i}`,
        chainageKm: 60 + i * 100,
        offRouteKm: 3.5,
      })),
    );
    const fetchedIds: number[] = [];
    const base = fakeStatiq(specs);
    const counting = {
      ...base,
      detailsWithMeta: async (id: number) => {
        fetchedIds.push(id);
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;

    const plan = await planTrip({ router: fakeRouter(700), statiq: counting }, O, D(700));
    // every candidate in BOTH bands was fetched, exactly once each
    expect(fetchedIds.length).toBe(20);
    expect(new Set(fetchedIds).size).toBe(20);
    expect(fetchedIds).toEqual(expect.arrayContaining([700, 701, 702, 703, 704, 705]));
    // selection still prefers the primary band when it can
    expect(plan.stops.every((s) => s.detourKm <= 2)).toBe(true);
  });

  it('fetches the whole batch up front - including fallback stations no window needs', async () => {
    // station 4 sits in a window that also has a primary option, so it is
    // never NEEDED for a stop; exhaustive fetch still reads its details.
    const specs: StationSpec[] = [
      { id: 1, name: 'Statiq Near A', chainageKm: 100, offRouteKm: 0 },
      { id: 4, name: 'Statiq Unneeded D', chainageKm: 250, offRouteKm: 3.2 },
      { id: 2, name: 'Statiq Offroute B', chainageKm: 390, offRouteKm: 3.2 },
      { id: 3, name: 'Statiq Near C', chainageKm: 600, offRouteKm: 0 },
    ];
    const fetchedIds: number[] = [];
    const base = fakeStatiq(specs);
    const counting = {
      ...base,
      detailsWithMeta: async (id: number) => {
        fetchedIds.push(id);
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;

    const plan = await planTrip({ router: fakeRouter(700), statiq: counting }, O, D(700));
    // all four candidates fetched (window-based pruning would skip 4)
    expect(fetchedIds.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(fetchedIds).size).toBe(4);
    // the off-route stop is still chosen honestly, with its warning
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

  it('MID-SCAN cap exhaustion carries incremental scan progress in the evidence', async () => {
    // regression (Linux review): scan stats used to be assigned only AFTER
    // scanCorridor returned, so a fatal stop mid-scan lost the actual
    // samples completed/ok/failed. Progress must now flow even when the
    // scan never completes: the evidence names the full planned sample
    // count (plan-first report) and the completed-so-far aggregates.
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 10 } },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('budget-exhausted');
    // 700 km / 12 km step + destination = 60 planned samples: known even
    // though the scan stopped part-way through
    expect((err as PlanningError).message).toContain('of 60 planned');
    // completed-so-far counters carried (the scan did do real work)
    expect((err as PlanningError).message).toMatch(
      /route samples covered \d+\/\d+ of 60 planned/,
    );
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

describe('not_determined terminal coverage snapshot', () => {
  const snapStations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
    id: 800 + i,
    name: `Statiq Snap ${i}`,
    chainageKm: 50 * (i + 1),
  }));

  it('mid-scan exhaustion reports unknown inventory and minimum known remaining', async () => {
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(snapStations) }, O, D(700),
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 10 } },
    ).catch((e) => e);
    const pe = err as PlanningError;
    expect(pe).toBeInstanceOf(PlanningError);
    expect(pe.code).toBe('not_determined');
    expect(pe.cause).toBe('budget-exhausted');
    const cov = pe.coverage!;
    expect(cov.candidateInventoryComplete).toBe(false);
    expect(cov.candidatesPlanned).toBe(0);
    expect(cov.samplesPlanned).toBe(60);
    expect(cov.samplesCompleted).toBeGreaterThan(0);
    expect(cov.samplesCompleted).toBeLessThan(60);
    expect(cov.remainingCalls).toBeGreaterThan(0);
    expect('plan' in pe).toBe(false);
  });

  it('exhaustion after a completed scan reports a known inventory', async () => {
    // 60 marker samples then one detail lookup: the cap lands in details.
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(snapStations) }, O, D(700),
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 61 } },
    ).catch((e) => e);
    const cov = (err as PlanningError).coverage!;
    expect(cov.candidateInventoryComplete).toBe(true);
    expect(cov.candidatesPlanned).toBeGreaterThan(1);
    expect(cov.samplesCompleted).toBe(cov.samplesPlanned);
    expect(cov.observedAttempts).toBe(cov.maxAttempts);
    expect(cov.unconfirmedReservations).toBe(0);
    expect(cov.remainingCalls).toBeGreaterThan(0);
  });

  it('a successful plan carries no coverage field', async () => {
    const plan = await planTrip({ router: fakeRouter(284.9), statiq: fakeStatiq([]) }, O, D(284.9));
    expect('coverage' in plan).toBe(false);
  });
});

/**
 * INCOMPLETE CANDIDATE DATA NEVER BECOMES AN IMPOSSIBILITY CLAIM.
 *
 * A per-station lookup that fails (transport error / non-2xx-shaped skip)
 * or returns a 200 with a null station leaves an UNKNOWN: unlike a
 * known-unusable station (all plugs faulted), an unknown candidate could
 * have been usable. The final live endpoint audit observed exactly this
 * shape (74 details 200, 1 details 400 -> skip-with-warning), so the
 * boundary is reachable in production.
 *
 * Guard (scoped, policy-preserving):
 * - a 'no usable station on this route' (no_route) claim requires ZERO
 *   unknown candidates;
 * - a 'nocharger within N km past X' (infeasible) claim requires zero
 *   unknowns INSIDE the claimed window (cursor, cursor+maxLeg];
 * unknowns elsewhere never poison a claim they cannot disprove (and a
 * trip that needs no claim still plans, with visible warnings).
 */
describe('incomplete candidate data never becomes an impossibility claim', () => {
  /** Wrap fakeStatiq so the given station's details lookup THROWS (unknown). */
  function statiqWithFailingDetails(
    specs: StationSpec[],
    failingIds: number[],
  ): StatiqClient {
    const base = fakeStatiq(specs);
    return {
      ...base,
      detailsWithMeta: async (id: number) => {
        if (failingIds.includes(id)) {
          throw new StatiqApiError(400, '/stations/details', '{"error":"bad request"}');
        }
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;
  }

  /** Wrap fakeStatiq so the given station's lookup returns a NULL station. */
  function statiqWithNullDetails(
    specs: StationSpec[],
    nullIds: number[],
  ): StatiqClient {
    const base = fakeStatiq(specs);
    return {
      ...base,
      detailsWithMeta: async (id: number) => {
        if (nullIds.includes(id)) {
          return {
            response: { ok: true, live: true, retained: false, source: 'test', station: null },
            fetchedAt: new Date(),
          };
        }
        return (base as unknown as { detailsWithMeta: (id: number) => Promise<unknown> }).detailsWithMeta(id);
      },
    } as unknown as StatiqClient;
  }

  it('a window gap whose only candidate is UNKNOWN fails as not_determined, not infeasible', async () => {
    // A@100 usable; B@350 unreachable-past (its lookup throws). From A the
    // (100, 400] window contains exactly B - unknown - so "gap exceeds the
    // safe running range" cannot be certified.
    const specs: StationSpec[] = [
      { id: 1, name: 'Statiq A', chainageKm: 100 },
      { id: 2, name: 'Statiq B', chainageKm: 350 },
    ];
    const err = await planTrip(
      { router: fakeRouter(700), statiq: statiqWithFailingDetails(specs, [2]) },
      O,
      D(700),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('candidate-holes');
    expect((err as PlanningError).message).toContain('cannot be certified impossible');
    expect((err as PlanningError).message).toContain('1 candidate charger');
  });

  it('the SAME geometry with KNOWN-unusable (faulted) data stays an honest infeasible claim', async () => {
    // Control for the policy distinction: unknown != known-unusable. B is
    // fetched cleanly and its plugs are genuinely faulted - complete data,
    // so the gap claim stands.
    const specs: StationSpec[] = [
      { id: 1, name: 'Statiq A', chainageKm: 100 },
      {
        id: 2,
        name: 'Statiq B',
        chainageKm: 350,
        plugs: [{ status: 'faulted', available: false, note: 'Faulted' }],
      },
    ];
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(specs) },
      O,
      D(700),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('infeasible');
  });

  it('a 200-with-null-station lookup is an unknown too (visible warning, no_route guarded)', async () => {
    // the entire route has ONE candidate and its lookup returns no data:
    // 'no usable station' cannot be certified; also proves the previously
    // SILENT null-station path now leaves a visible warning
    const specs: StationSpec[] = [{ id: 1, name: 'Vanishing Statiq', chainageKm: 100 }];
    const err = await planTrip(
      { router: fakeRouter(700), statiq: statiqWithNullDetails(specs, [1]) },
      O,
      D(700),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('not_determined');
    expect((err as PlanningError).cause).toBe('candidate-holes');
    expect((err as PlanningError).message).toContain('cannot be certified');
  });

  it('no usable station IS claimable when every lookup completed (control)', async () => {
    const specs: StationSpec[] = [
      {
        id: 1,
        name: 'All-Faulted Statiq',
        chainageKm: 100,
        plugs: [{ status: 'faulted', available: false, note: 'Faulted' }],
      },
    ];
    const err = await planTrip(
      { router: fakeRouter(700), statiq: fakeStatiq(specs) },
      O,
      D(700),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).code).toBe('no_route');
  });

  it('keeps a no-stop trip available but marks unknown candidate coverage degraded', async () => {
    // 250 km from 100% SoC needs no stops. The successful plan remains
    // available, but incomplete candidate evidence is not full coverage.
    // Its lookup failure leaves a visible warning and degraded status.
    const specs: StationSpec[] = [{ id: 1, name: 'Unreachable Statiq', chainageKm: 125 }];
    const plan = await planTrip(
      { router: fakeRouter(250), statiq: statiqWithFailingDetails(specs, [1]) },
      O,
      D(250),
    );
    expect(plan.status).toBe('degraded');
    expect(plan.stops).toHaveLength(0);
    expect(plan.warnings.some((w) => w.includes('live details unavailable'))).toBe(true);
  });
});

/** Mutate raw provider details after fixture construction, so null/missing
 * values are not replaced by stationDetail's convenience defaults. */
function mutateRawChargers(specs: StationSpec[], mutate: (chargers: StatiqCharger[], id: number) => void): StatiqClient {
  const base = fakeStatiq(specs);
  return {
    ...base,
    detailsWithMeta: async (id: number) => {
      const result = await base.detailsWithMeta(id);
      if (result.response.station) mutate(result.response.station.chargers, id);
      return result;
    },
  } as unknown as StatiqClient;
}
const numericSpecs: StationSpec[] = [200, 450].map((chainageKm, index) => ({ id: index + 1, name: `Statiq ${chainageKm}`, chainageKm }));

it.each([0, -60, '60', 'bad', NaN, Infinity])('does not certify a required stop with malformed-only power %j', kw => {
  const statiq = mutateRawChargers(numericSpecs, chargers => Object.assign(chargers[0]!, { kw }));
  return expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined', cause: 'candidate-holes' });
});

it.each([false, true])('uses a valid charger with a visible malformed sibling warning, invalid-first=%s', invalidFirst => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    chargers.push({ ...chargers[0]!, kw: 'bad' as unknown as number, pricePerKwh: 999 });
    if (invalidFirst) chargers.reverse();
  });
  return planTrip({ router: fakeRouter(700), statiq }, O, D(700)).then(plan => {
    expect(plan.status).toBe('ok'); expect(plan.stops).toHaveLength(2);
    expect(plan.stops.every(stop => stop.chargeTimeMin > 0 && Number.isFinite(stop.chargeTimeMin) && stop.pricePerKwh === 20)).toBe(true);
    expect(plan.warnings.join(' ')).toContain('known power only');
    expect(plan.totals.chargeTimeMin).toBeGreaterThan(0); expect(Number.isFinite(plan.totals.totalTimeMin)).toBe(true);
  });
});

it('keeps an independently justified alternate route but discloses a genuine numeric candidate hole', async () => {
  const specs = [...numericSpecs, { id: 3, name: 'Malformed candidate', chainageKm: 250 }];
  const statiq = mutateRawChargers(specs, (chargers, id) => { if (id === 3) Object.assign(chargers[0]!, { kw: 0 }); });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('degraded'); expect(plan.stops).toHaveLength(2);
  expect(plan.stops.some(stop => stop.station.stationId === 3)).toBe(false);
  expect(plan.warnings.join(' ')).toContain('power is invalid');
  expect(Number.isFinite(plan.totals.totalTimeMin)).toBe(true);
});

it.each([null, undefined])('preserves the legacy absent-only %j power estimate with a visible warning', async kw => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    if (kw === undefined) delete (chargers[0] as Partial<StatiqCharger>).kw;
    else Object.assign(chargers[0]!, { kw });
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  const control = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(numericSpecs.map(spec => ({ ...spec, kw: 50 }))) }, O, D(700));
  expect(plan.status).toBe('ok'); expect(plan.stops.map(stop => stop.chargeTimeMin)).toEqual(control.stops.map(stop => stop.chargeTimeMin));
  expect(plan.warnings.join(' ')).toContain('50 kW estimate');
});

it.each([-20, '20', 'bad', null, undefined, NaN, Infinity])('keeps selected tariff %j unknown without concealing total cost', async pricePerKwh => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    if (pricePerKwh === undefined) delete (chargers[0] as Partial<StatiqCharger>).pricePerKwh;
    else Object.assign(chargers[0]!, { pricePerKwh });
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.stops.every(stop => stop.pricePerKwh === null && stop.estPriceInr === null)).toBe(true);
  expect(plan.totals.estPriceInr).toBeNull(); expect(Number.isFinite(plan.totals.totalTimeMin)).toBe(true);
});

it('keeps a genuine zero tariff as zero without borrowing or manufacturing a price', async () => {
  const statiq = mutateRawChargers(numericSpecs, chargers => Object.assign(chargers[0]!, { pricePerKwh: 0 }));
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.stops.every(stop => stop.pricePerKwh === 0 && stop.estPriceInr === 0)).toBe(true);
  expect(plan.totals.estPriceInr).toBe(0); expect(plan.totals.chargeTimeMin).toBeGreaterThan(0);
});

it('does not create a coverage hole from an unrelated faulted charger with bad numeric metadata', async () => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    chargers.push({ ...chargers[0]!, kw: -1, pricePerKwh: -1, connectors: chargers[0]!.connectors.map(connector => ({ ...connector, status: 'faulted', available: false, note: 'Faulted' })) });
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('ok'); expect(plan.warnings.join(' ')).not.toContain('incomplete charger power');
  expect(plan.totals.chargeTimeMin).toBeGreaterThan(0); expect(plan.totals.estPriceInr).toBeGreaterThan(0);
});

it('still fetches every candidate once before resolving malformed power uncertainty', async () => {
  const calls: number[] = []; const base = fakeStatiq(numericSpecs);
  const statiq = { ...base, detailsWithMeta: async (id: number) => {
    calls.push(id); const result = await base.detailsWithMeta(id);
    Object.assign(result.response.station!.chargers[0]!, { kw: 0 }); return result;
  } } as unknown as StatiqClient;
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined' });
  expect(calls.sort()).toEqual([1, 2]);
});

it('does not publish nonfinite charging time from a positive but unrepresentable power estimate', async () => {
  const statiq = mutateRawChargers(numericSpecs, chargers => Object.assign(chargers[0]!, { kw: Number.MIN_VALUE }));
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined' });
});

it('keeps overflowed charging cost unknown rather than serializing Infinity as null silently', async () => {
  const statiq = mutateRawChargers(numericSpecs, chargers => Object.assign(chargers[0]!, { pricePerKwh: Number.MAX_VALUE }));
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.stops.every(stop => stop.estPriceInr === null)).toBe(true);
  expect(plan.totals.estPriceInr).toBeNull(); expect(plan.warnings.join(' ')).toContain('outside the supported range');
});

it.each([false, true])('never uses the absent-only fallback for missing plus malformed required power, invalid-first=%s', async invalidFirst => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    const template = chargers[0]!;
    delete (template as Partial<StatiqCharger>).kw;
    chargers.push({ ...template, kw: -60 });
    if (invalidFirst) chargers.reverse();
  });
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined', cause: 'candidate-holes' });
});

it.each([false, true])('keeps known valid power rather than fallback when missing sibling comes first=%s', async missingFirst => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    const missing: Partial<StatiqCharger> = { ...chargers[0]!, pricePerKwh: 999 };
    delete missing.kw; chargers.push(missing as StatiqCharger);
    if (missingFirst) chargers.reverse();
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  const control = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(numericSpecs) }, O, D(700));
  expect(plan.status).toBe('ok');
  expect(plan.stops.map(stop => [stop.chargeTimeMin, stop.pricePerKwh])).toEqual(control.stops.map(stop => [stop.chargeTimeMin, stop.pricePerKwh]));
  expect(plan.warnings.join(' ')).toContain('known power only');
  expect(plan.warnings.join(' ')).not.toContain('50 kW estimate');
});

it('does not certify complete coverage when all marker records have malformed coordinates', async () => {
  const base = fakeStatiq(numericSpecs);
  const statiq = { ...base, markers: async () => ({ ok: true, stations: [{ stationId: 999, name: 'Malformed marker', lat: 'bad', lon: 0 }] }) } as unknown as StatiqClient;
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined', cause: 'scan-coverage' });
});

it.each([false, true])('preserves every valid candidate and marks one malformed-marker sample degraded, invalid-first=%s', async invalidFirst => {
  const base = fakeStatiq(numericSpecs); let markerCalls = 0; const details: number[] = [];
  const statiq = { ...base,
    markers: async (lat: number, lon: number) => {
      const response = await base.markers(lat, lon); markerCalls++;
      if (markerCalls === 1) {
        const valid = numericSpecs.map(spec => ({ stationId: spec.id, name: spec.name, lat: spec.chainageKm / KM_PER_DEG, lon: 0, address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }));
        const malformed = { ...valid[0]!, lat: 'bad' };
        return { ...response, stations: invalidFirst ? [malformed, ...valid] : [valid[0], malformed, valid[1]] };
      }
      return response;
    },
    detailsWithMeta: async (id: number) => { details.push(id); return base.detailsWithMeta(id); },
  } as unknown as StatiqClient;
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('degraded'); expect(plan.stops).toHaveLength(2);
  expect(details.sort()).toEqual([1, 2]); expect(plan.stationsSeen).toBe(2);
  expect(plan.warnings.filter(w => w.includes('Charger scan could not read'))).toHaveLength(1);
});

it.each(['available', 'charging', 'preparing', 'finishing'])('malformed-only %s availability leaves required candidates unknown, not certified absent', async status => {
  const seen: number[] = [];
  const statiq = mutateRawChargers(numericSpecs, (chargers, id) => {
    seen.push(id); Object.assign(chargers[0]!.connectors[0]!, { status, available: 'false', note: null });
  });
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined', cause: 'candidate-holes' });
  expect(seen.sort()).toEqual([1, 2]);
});

it.each([false, true])('retains valid connector sibling without borrowing malformed power/tariff, invalid-first=%s', async invalidFirst => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    const source = chargers[0]!;
    chargers.push({ ...source, kw: 200, pricePerKwh: 999, connectors: [{ ...source.connectors[0]!, status: 'available', available: 'false' as unknown as boolean, note: null }] });
    if (invalidFirst) chargers.reverse();
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.stops).toHaveLength(2); expect(plan.stops.every(stop => stop.pricePerKwh === 20)).toBe(true);
  expect(plan.warnings.join(' ')).toContain('invalid connector availability');
  expect(plan.status).toBe('ok');
  const control = await planTrip({ router: fakeRouter(700), statiq: fakeStatiq(numericSpecs) }, O, D(700));
  expect(plan.totals).toEqual(control.totals);
});

it('retains independent alternate plan but degrades malformed-only candidate coverage', async () => {
  const specs = [...numericSpecs, { id: 3, name: 'Unknown availability', chainageKm: 250 }];
  const statiq = mutateRawChargers(specs, (chargers, id) => { if (id === 3) Object.assign(chargers[0]!.connectors[0]!, { available: 'false' }); });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('degraded'); expect(plan.stops).toHaveLength(2);
  expect(plan.stops.some(stop => stop.station.stationId === 3)).toBe(false);
  expect(plan.warnings.join(' ')).toContain('connector availability is invalid');
});

it('keeps no-stop result available and degraded when candidate availability is unknown', async () => {
  const statiq = mutateRawChargers([{ id: 1, name: 'Unknown availability', chainageKm: 100 }], chargers => Object.assign(chargers[0]!.connectors[0]!, { available: 'false' }));
  const plan = await planTrip({ router: fakeRouter(250), statiq }, O, D(250));
  expect(plan.status).toBe('degraded'); expect(plan.stops).toHaveLength(0);
});

it.each([null, undefined])('keeps legacy missing/null availability %j candidates eligible', async available => {
  const statiq = mutateRawChargers(numericSpecs, chargers => Object.assign(chargers[0]!.connectors[0]!, { available }));
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('ok'); expect(plan.stops).toHaveLength(2);
});

it('does not create candidate holes from definitely faulted/offline malformed availability', async () => {
  const statiq = mutateRawChargers(numericSpecs, chargers => {
    const source = chargers[0]!;
    chargers.push({ ...source, kw: 200, pricePerKwh: 999, connectors: [{ ...source.connectors[0]!, status: 'faulted', available: 'false' as unknown as boolean, note: 'Faulted' }] });
  });
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('ok'); expect(plan.warnings.join(' ')).not.toContain('invalid connector availability');
  expect(plan.stops.every(stop => stop.pricePerKwh === 20)).toBe(true);
});

it.each([{ live: false }, { retained: true }, { live: 'true' }, { retained: null }])('details consumer treats nonfresh %j as unknown candidate evidence', async evidence => {
  const source = fakeStatiq(numericSpecs); const calls: number[] = [];
  const statiq = { ...source, detailsWithMeta: async (id: number) => {
    calls.push(id); const result = await source.detailsWithMeta(id); Object.assign(result.response, evidence); return result;
  } } as unknown as StatiqClient;
  await expect(planTrip({ router: fakeRouter(700), statiq }, O, D(700))).rejects.toMatchObject({ code: 'not_determined', cause: 'candidate-holes' });
  expect(calls.sort()).toEqual([1, 2]);
});

it('independently supported alternate excludes nonfresh candidate and discloses degraded coverage', async () => {
  const specs = [...numericSpecs, { id: 3, name: 'Retained fixture', chainageKm: 250 }];
  const source = fakeStatiq(specs);
  const statiq = { ...source, detailsWithMeta: async (id: number) => {
    const result = await source.detailsWithMeta(id); if (id === 3) Object.assign(result.response, { retained: true }); return result;
  } } as unknown as StatiqClient;
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('degraded'); expect(plan.stops.some(stop => stop.station.stationId === 3)).toBe(false);
});

it('one nonfresh marker sample is a hole without consuming its records or failing unrelated samples', async () => {
  const source = fakeStatiq(numericSpecs); let samples = 0;
  const statiq = { ...source, markers: async (lat: number, lon: number) => {
    const result = await source.markers(lat, lon);
    if (++samples === 1) Object.assign(result, { live: false, stations: [{ stationId: 999, name: 'Retained only', lat: 0.1, lon: 0 }] });
    return result;
  } } as unknown as StatiqClient;
  const plan = await planTrip({ router: fakeRouter(700), statiq }, O, D(700));
  expect(plan.status).toBe('degraded'); expect(plan.stops.some(stop => stop.station.stationId === 999)).toBe(false);
  expect(plan.warnings.filter(warning => warning.includes('could not read the sample'))).toHaveLength(1);
});
type PlannerViaFact = { label: string; lat: number; lon: number };
interface PlannerRouteCall {
  origin: Coords;
  destination: Coords;
  via?: readonly PlannerViaFact[];
}

function recordingPlannerRouter(totalKm: number, calls: PlannerRouteCall[], hold?: Promise<void>, onDispatch?: () => void): OsrmRouter {
  return { route: async (origin: Coords, destination: Coords, _signal?: AbortSignal, via?: readonly Coords[]) => {
    calls.push({ origin: { ...origin }, destination: { ...destination },
      via: via?.map(point => ({ label: (point as PlannerViaFact).label, lat: point.lat, lon: point.lon })) });
    onDispatch?.();
    if (hold) await hold;
    return makeRoute(totalKm);
  }} as unknown as OsrmRouter;
}
function countingPlannerDeps(counts: { router: number; statiq: number }) {
  return {
    router: { route: async () => { counts.router++; return makeRoute(450); } } as unknown as OsrmRouter,
    statiq: { markers: async () => { counts.statiq++; throw new Error("unexpected provider dispatch"); } } as unknown as StatiqClient,
  };
}

for (const [name, via] of [
  ["one", [{ label: "V One", lat: 1, lon: 1 }]],
  ["five", [
    { label: "V1", lat: 1, lon: 1 }, { label: "V2", lat: 2, lon: 2 }, { label: "V3", lat: 3, lon: 3 },
    { label: "V4", lat: 4, lon: 4 }, { label: "V5", lat: 5, lon: 5 },
  ]],
] as const) {
  it("routes through " + name + " ordered stopover(s) in one full route", async () => {
    const input: PlannerViaFact[] = via.map(point => ({ label: point.label, lat: point.lat, lon: point.lon }));
    const expected = input.map(point => ({ ...point }));
    const calls: PlannerRouteCall[] = [];
    const stations: StationSpec[] = [{ id: 1, name: "Statiq 250", chainageKm: 250 }];
    const plan = await planTrip({ router: recordingPlannerRouter(450, calls), statiq: fakeStatiq(stations) }, O, D(450), { via: input });
    expect(calls.length).toBe(1);
    expect(calls[0]?.origin).toEqual(O);
    expect(calls[0]?.destination).toEqual(D(450));
    expect(calls[0]?.via).toEqual(expected);
    expect(plan.via).toEqual(expected);
    expect(plan.routeDistanceKm).toBeCloseTo(450, 1);
    const baseline = await planTrip({ router: fakeRouter(450), statiq: fakeStatiq(stations) }, O, D(450));
    expect(plan.geometry).toEqual(baseline.geometry);
    expect(plan.totals).toEqual(baseline.totals);
    expect(plan.totals.finalSocPct).toBeGreaterThan(9);
    expect(plan.stops.map(s => [s.chainageKm, s.arriveSocPct, s.leaveSocPct, s.chargeKwh]))
      .toEqual(baseline.stops.map(s => [s.chainageKm, s.arriveSocPct, s.leaveSocPct, s.chargeKwh]));
  });
}

for (const [name, options] of [
  ["empty array", { via: [] as readonly PlannerViaFact[] }],
  ["explicit undefined", { via: undefined }],
] as const) {
  it("keeps the A-B plan shape for " + name, async () => {
    const calls: PlannerRouteCall[] = [];
    const plan = await planTrip({ router: recordingPlannerRouter(284.9, calls), statiq: fakeStatiq([]) }, O, D(284.9), options);
    expect(calls.length).toBe(1);
    expect(calls[0]?.via).toEqual([]);
    expect(plan).not.toHaveProperty("via");
    expect(plan.routeDistanceKm).toBeCloseTo(284.9, 1);
    expect(plan.stops).toHaveLength(0);
  });
}

it("copies caller via facts before an awaited router dispatch", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let dispatched!: () => void;
  const routed = new Promise<void>(resolve => { dispatched = resolve; });
  const input: PlannerViaFact[] = [
    { label: "Original", lat: 1, lon: 1 }, { label: "Second", lat: 2, lon: 2 },
  ];
  const expected = input.map(point => ({ ...point }));
  const calls: PlannerRouteCall[] = [];
  const stations: StationSpec[] = [{ id: 1, name: "Statiq 250", chainageKm: 250 }];
  const pending = planTrip({ router: recordingPlannerRouter(450, calls, held, dispatched), statiq: fakeStatiq(stations) }, O, D(450), { via: input });
  await routed;
  input[0]!.label = "Mutated"; input[0]!.lat = 9; input[0]!.lon = 8;
  input.push({ label: "Extra", lat: 3, lon: 3 });
  release();
  const plan = await pending;
  expect(calls.length).toBe(1);
  expect(calls[0]?.via).toEqual(expected);
  expect(plan.via).toEqual(expected);
  const baseline = await planTrip({ router: fakeRouter(450), statiq: fakeStatiq(stations) }, O, D(450));
  expect(plan.totals).toEqual(baseline.totals);
  expect(plan.routeDistanceKm).toBe(baseline.routeDistanceKm);
});

it.each([
  ["null", null],
  ["six", Array.from({ length: 6 }, (_, i) => ({ label: "V" + i, lat: i, lon: 0 }))],
  ["blank label", [{ label: "  ", lat: 1, lon: 1 }]],
  ["NaN", [{ label: "V", lat: Number.NaN, lon: 1 }]],
  ["out of bounds", [{ label: "V", lat: 91, lon: 1 }]],
  ["sparse", Array(2)],
])("rejects %s via input before router or provider dispatch", async (_name, via) => {
  const counts = { router: 0, statiq: 0 };
  await expect(planTrip(countingPlannerDeps(counts), O, D(450), { via: via as never })).rejects.toMatchObject({ name: "RouterError", code: "InvalidWaypoints" });
  expect(counts).toEqual({ router: 0, statiq: 0 });
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60', null])("rejects invalid maxChargerKw %s before dispatch", async (maxChargerKw) => {
  const counts = { router: 0, statiq: 0 };
  await expect(planTrip(countingPlannerDeps(counts), O, D(450), { maxChargerKw: maxChargerKw as never })).rejects.toMatchObject({ name: "RouterError", code: "InvalidWaypoints" });
  expect(counts).toEqual({ router: 0, statiq: 0 });
});
