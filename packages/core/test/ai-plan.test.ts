import { describe, expect, it } from 'vitest';
import { planTripDetailed, finalize, type PlanBundle, type PlannerCandidate } from '../src/planner.js';
import { assembleAiPlan, validateAiChoice } from '../src/ai-plan.js';
import { DEFAULT_PLAN_OPTIONS, type TripPlan } from '../src/plan-types.js';
import { HARIER_EV_75, chargeTimeMin, kwhForSocDelta, socAfterDriving, socRequiredForArrival } from '../src/vehicle.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse, StatiqStationDetail, StatiqCharger } from '../src/types.js';
import type { Coords } from '../src/geo.js';

const KM_PER_DEG = 111.32;

function routeLengthKmForTest(geometry: Coords[]): number {
  let total = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1] as Coords;
    const b = geometry[i] as Coords;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    total += 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return total;
}

function makeRoute(totalKm: number): RouteResult {
  const n = Math.max(2, Math.ceil(totalKm / 10));
  const geometry: Coords[] = Array.from({ length: n + 1 }, (_, i) => ({
    lat: (totalKm / KM_PER_DEG) * (i / n),
    lon: 0,
  }));
  return { distanceKm: totalKm, durationMin: totalKm, geometry };
}

function fakeRouter(totalKm: number): OsrmRouter {
  return { route: async () => makeRoute(totalKm) } as unknown as OsrmRouter;
}

interface StationSpec {
  id: number;
  name: string;
  chainageKm: number;
  chargers?: StatiqCharger[];
}

function stationDetail(spec: StationSpec): StatiqStationDetail {
  const chargers: StatiqCharger[] = spec.chargers ?? [
    {
      chargerId: spec.id * 10 + 1,
      name: `${spec.name} DC`,
      type: 'DC',
      kw: 60,
      pricePerKwh: 20,
      currency: 'INR',
      lastUsedOn: '19/11/2026',
      connectors: [
        { displayId: 1, connectorId: spec.id * 100, type: 'CCS-2', status: 'available', available: true, note: null },
      ],
    },
  ];
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
  return {
    markers: async (lat: number): Promise<StatiqMarkersResponse> => {
      const centerKm = lat * KM_PER_DEG;
      const stations = specs
        .filter((s) => Math.abs(s.chainageKm - centerKm) <= 13)
        .map((s) => ({
          stationId: s.id,
          name: s.name,
          lat: s.chainageKm / KM_PER_DEG,
          lon: 0,
          address: null,
          accessType: 1,
          isCommunityListed: false,
          stationUrl: '',
        }));
      return { ok: true, live: true, retained: false, source: 'test', count: stations.length, stations };
    },
    detailsWithMeta: async (id: number) => ({
      response: {
        ok: true,
        live: true,
        retained: false,
        source: 'test',
        station: details.get(id) ?? null,
      } as StatiqDetailsResponse,
      fetchedAt: new Date(),
    }),
  } as unknown as StatiqClient;
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });

// Long route with stations every 50 km; the greedy plan picks ~300 km legs.
const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
  id: 300 + i,
  name: `Statiq ${i}`,
  chainageKm: 50 * (i + 1),
}));

describe('validateAiChoice', () => {
  it('still charges above the usual cap and warns when a long next hop really needs it', () => {
    const bundle = handBuiltBundle([100], 400);
    const validation = validateAiChoice(bundle, { stationIds: [idAt(100)] }, { startSocPct: 50 }, HARIER_EV_75);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const warnings: string[] = [];
    const stops = finalize(validation.seq, 400, bundle.route,
      { ...DEFAULT_PLAN_OPTIONS, startSocPct: 50 }, HARIER_EV_75, warnings);
    const stop = stops[0]!;
    expect(stop.leaveSocPct).toBeGreaterThan(80);
    expect(stop.leaveSocPct).toBeLessThanOrEqual(95);
    expect(stop.chargeKwh).toBeGreaterThan(0);
    expect(stop.chargeTimeMin).toBeGreaterThan(0);
    expect(warnings.some((warning) => warning.includes('above the usual 80%'))).toBe(true);
  });

  it.each([20, 50, 80, 100])('keeps leg energy and charge accounting coherent from %s percent', (startSocPct) => {
    const bundle = handBuiltBundle([20, 60, 180], 250);
    const validation = validateAiChoice(bundle, { stationIds: [idAt(20), idAt(60), idAt(180)] }, { startSocPct }, HARIER_EV_75);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const stops = finalize(validation.seq, 250, bundle.route,
      { ...DEFAULT_PLAN_OPTIONS, startSocPct }, HARIER_EV_75, []);
    let departure = startSocPct;
    for (const stop of stops) {
      expect(stop.arriveSocPct).toBeCloseTo(socAfterDriving(stop.legKm, departure), 0);
      expect(stop.leaveSocPct).toBeGreaterThanOrEqual(stop.arriveSocPct);
      expect(stop.chargeKwh).toBeGreaterThanOrEqual(0);
      expect(stop.chargeTimeMin).toBeGreaterThanOrEqual(0);
      departure = stop.leaveSocPct;
    }
  });

  it('never lowers an excess arrival charge when the next leg needs more than the usual cap', () => {
    const bundle = handBuiltBundle([10], 300);
    const validation = validateAiChoice(bundle, { stationIds: [idAt(10)] }, {}, HARIER_EV_75);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const warnings: string[] = [];
    const stops = finalize(validation.seq, 300, bundle.route, DEFAULT_PLAN_OPTIONS, HARIER_EV_75, warnings);
    expect(stops[0]!.arriveSocPct).toBeGreaterThan(95);
    expect(stops[0]!.leaveSocPct).toBeGreaterThanOrEqual(stops[0]!.arriveSocPct);
    expect(stops[0]!.chargeKwh).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('preserves excess battery energy between closely spaced early stops', () => {
    const bundle = handBuiltBundle([50, 100], 200);
    const validation = validateAiChoice(bundle, { stationIds: [idAt(50), idAt(100)] }, {}, HARIER_EV_75);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const stops = finalize(validation.seq, 200, bundle.route, DEFAULT_PLAN_OPTIONS, HARIER_EV_75, []);
    expect(stops[0]!.chargeKwh).toBe(0);
    expect(stops[1]!.arriveSocPct).toBeCloseTo(socAfterDriving(50, stops[0]!.leaveSocPct), 0);
    expect(stops[1]!.chargeKwh).toBe(0);
    expect(stops[1]!.chargeTimeMin).toBe(0);
    expect(stops[1]!.estPriceInr).toBe(0);
  });

  it('rejects an energy-reachable final leg that exceeds the 300 km hard gap', () => {
    const bundle = handBuiltBundle([300], 650);
    const v = validateAiChoice(bundle, { stationIds: [idAt(300)] }, {}, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('safe running range');
  });

  it('rejects an intermediate hop a full battery cannot reach with reserve', () => {
    const bundle = handBuiltBundle([50, 250], 300);
    const vehicle = { ...HARIER_EV_75, whPerKm: 500 };
    const v = validateAiChoice(bundle, { stationIds: [idAt(50), idAt(250)] }, {}, vehicle);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('reserve');
  });

  it('keeps a valid near-boundary final leg eligible', () => {
    const bundle = handBuiltBundle([50], 350);
    expect(validateAiChoice(bundle, { stationIds: [idAt(50)] }, {}, HARIER_EV_75).ok).toBe(true);
  });

  it('accepts the AI choosing the same stops as the base plan', async () => {
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { includeCandidates: true },
    );
    const ids = bundle.plan.stops.map((s) => s.station.stationId);
    const v = validateAiChoice(bundle, { stationIds: ids }, {}, HARIER_EV_75);
    expect(v.ok).toBe(true);
  });

  it('accepts a valid alternative sequence with coherent numbers', async () => {
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { includeCandidates: true },
    );
    // choose 300 km + 300 km legs instead of the greedy ~300 + ~300 picks
    const alt = [305, 311]; // chainages 300 km and 600 km
    const v = validateAiChoice(bundle, { stationIds: alt }, {}, HARIER_EV_75);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const plan = assembleAiPlan(bundle, v.seq, { applied: true, notes: 'prefers even spacing' }, {}, HARIER_EV_75);
    expect(plan.stops.map((s) => s.station.stationId)).toEqual(alt);
    for (const s of plan.stops) {
      expect(s.arriveSocPct).toBeGreaterThanOrEqual(10 - 0.5);
      expect(s.leaveSocPct).toBeGreaterThanOrEqual(s.arriveSocPct);
      expect(s.legKm).toBeLessThanOrEqual(300.5);
    }
    expect(plan.totals.finalSocPct).toBeGreaterThanOrEqual(10);
    expect(plan.warnings.some((w) => w.includes('AI'))).toBe(true);
  });

  it('rejects forged selection metadata and invalid caps before certification', async () => {
    const bundle = handBuiltBundle([50], 300);
    const candidate = bundle.usableCandidates[0]!;
    candidate.view.chargers = [{ chargerId: 8, name: '60 kW', type: 'DC', kw: 60, pricePerKwh: 22,
      lastUsedOn: null, plugs: [{ connectorId: 80, type: 'CCS-2', health: 'working-free', planningHealth: 'working-free', contradiction: false }] }];
    const id = candidate.candidate.stationId;
    delete candidate.selectedCharger;
    let v = validateAiChoice(bundle, { stationIds: [id] }, { maxChargerKw: 100 }, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('live charger evidence');
    candidate.selectedCharger = { chargerId: 9, name: 'forged', kw: 60, pricePerKwh: 99 };
    v = validateAiChoice(bundle, { stationIds: [id] }, { maxChargerKw: 100 }, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('live charger evidence');
    v = validateAiChoice(bundle, { stationIds: [id] }, { maxChargerKw: Number.NaN }, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('finite positive');
  });

  it('certifies a mixed-site null tariff through candidate projection and AI rebuild', async () => {
    const siteStations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
      id: 300 + i, name: `Statiq ${i}`, chainageKm: 50 * (i + 1),
    }));
    const mixed = siteStations[5]!;
    const connector = { displayId: 1, connectorId: mixed.id * 100, type: 'CCS-2',
      status: 'available', available: true, note: null };
    mixed.chargers = [
      { chargerId: mixed.id * 10 + 1, name: '180 kW', type: 'DC', kw: 180, pricePerKwh: 18,
        currency: 'INR', lastUsedOn: null, connectors: [connector] },
      { chargerId: mixed.id * 10 + 2, name: '60 kW', type: 'DC', kw: 60, pricePerKwh: null,
        currency: 'INR', lastUsedOn: null, connectors: [connector] },
    ];
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq: fakeStatiq(siteStations) }, O, D(700),
      { includeCandidates: true, maxChargerKw: 100 },
    );
    const projected = bundle.plan.candidates?.find(c => c.stationId === mixed.id);
    expect(projected).toMatchObject({ maxKw: 60, pricePerKwh: null });
    expect(projected?.selectedCharger).toMatchObject({ kw: 60, pricePerKwh: null });
    const v = validateAiChoice(bundle, { stationIds: bundle.plan.stops.map(s => s.station.stationId) },
      { maxChargerKw: 100 }, HARIER_EV_75);
    expect(v.ok).toBe(true); if (!v.ok) return;
    const rebuilt = assembleAiPlan(bundle, v.seq, { applied: true }, { maxChargerKw: 100 }, HARIER_EV_75);
    const stop = rebuilt.stops.find(s => s.station.stationId === mixed.id);
    expect(stop).toBeDefined(); if (!stop) return;
    expect(stop.pricePerKwh).toBeNull();
    expect(stop.estPriceInr).toBeNull();
    expect(stop.selectedCharger).toMatchObject({ kw: 60, pricePerKwh: null });
    expect(stop.chargeTimeMin).toBe(Math.round(chargeTimeMin(stop.arriveSocPct, stop.leaveSocPct, 60, HARIER_EV_75)));
  });

  it('rejects unknown ids', async () => {
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { includeCandidates: true },
    );
    const v = validateAiChoice(bundle, { stationIds: [999] }, {}, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('not among');
  });

  it('rejects out-of-order sequences', async () => {
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq: fakeStatiq(stations) },
      O,
      D(700),
      { includeCandidates: true },
    );
    const v = validateAiChoice(bundle, { stationIds: [311, 301] }, {}, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('order');
  });

  it('rejects a leg beyond the 300 km safe range (hand-built candidates)', () => {
    const bundle = handBuiltBundle([50, 200, 450, 650], 700);
    const v = validateAiChoice(bundle, { stationIds: [idAt(50), idAt(450)] }, {}, HARIER_EV_75);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('safe running range');
  });

  it('rejects a first stop the starting charge cannot reach', () => {
    const bundle = handBuiltBundle([65, 200, 450, 650], 700);
    // 65 km from a 20% start leaves ~4.8% on arrival - below the 10% floor
    const v = validateAiChoice(
      bundle,
      { stationIds: [idAt(65)] },
      { startSocPct: 20 },
      HARIER_EV_75,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason.toLowerCase()).toContain('cannot reach');
  });
});

const STATION_BASE_ID = 900;
/** Deterministic per-chainage id so tests can reference bundle stations. */
function idAt(chainage: number): number {
  return STATION_BASE_ID + chainage;
}

/**
 * Build a bundle-shaped object with candidates at the given chainages —
 * for testing validation without the greedy planner needing to succeed.
 */
function handBuiltBundle(chainages: number[], totalKm: number): PlanBundle {
  const route = makeRoute(totalKm);
  const usableCandidates: PlannerCandidate[] = chainages.map((ch) => {
    const id = idAt(ch);
    return {
      candidate: {
        stationId: id,
        name: `Hand ${ch}`,
        lat: ch / KM_PER_DEG,
        lon: 0,
        chainageKm: ch,
        offRouteKm: 0,
        marker: {
          stationId: id,
          name: `Hand ${ch}`,
          lat: ch / KM_PER_DEG,
          lon: 0,
          address: null,
          accessType: 1,
          isCommunityListed: false,
          stationUrl: '',
        },
      },
      summary: { total: 1, usable: 1, free: 1, occupied: 0, uncertain: 0, faulted: 0, offline: 0, policyExcluded: 0, maxKw: 60, pricePerKwh: 20, hasInvalidUsablePower: false, hasInvalidUsableAvailability: false, hasMissingUsablePower: false, hasInvalidSelectedTariff: false, hasContradiction: false, isUsable: true },
      view: {
        stationId: id,
        name: `Hand ${ch}`,
        brand: 'statiq' as const,
        lat: ch / KM_PER_DEG,
        lon: 0,
        address: null,
        city: null,
        hours: null,
        openText: null,
        rating: 4,
        reviewCount: 10,
        reliability: null,
        fetchedAt: new Date().toISOString(),
        amenities: [],
        stationUrl: null,
        navUrl: null,
        chargers: [],
      },
    };
  });
  // Complete base plan: assembleAiPlan spreads the base and reads warnings,
  // so a partial object would make this fixture unusable for rebuild tests.
  const basePlan: TripPlan = {
    id: `fixture-${totalKm}`,
    createdAt: new Date().toISOString(),
    origin: { label: 'Fixture origin', lat: 0, lon: 0 },
    destination: { label: 'Fixture destination', lat: totalKm / KM_PER_DEG, lon: 0 },
    vehicle: {
      label: 'Fixture Harrier',
      catalogId: null,
      batteryKwh: HARIER_EV_75.batteryKwh,
      claimedRangeKm: null,
      realWorldRangeKm: null,
    },
    status: 'ok',
    source: 'live',
    routeDistanceKm: route.distanceKm,
    routeDurationMin: route.durationMin,
    geometry: route.geometry,
    stops: [],
    totals: {
      distanceKm: route.distanceKm,
      driveTimeMin: route.durationMin,
      chargeTimeMin: 0,
      totalTimeMin: route.durationMin,
      chargeKwh: 0,
      estPriceInr: 0,
      finalSocPct: 100,
    },
    stationsSeen: chainages.length,
    warnings: [],
  };
  return { plan: basePlan, usableCandidates, route };
}

describe('AI-safe candidates', () => {
  it('carry no plug occupancy and no health detail', async () => {
    const occupied: StationSpec[] = [
      { id: 50, name: 'Busy Statiq', chainageKm: 100 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: 60 + i, name: `S ${i}`, chainageKm: 250 + i * 50 })),
    ];
    const statiq = fakeStatiq(occupied);
    const baseline = await planTripDetailed({ router: fakeRouter(700), statiq }, O, D(700), { includeCandidates: true });
    const baselineProjection = JSON.stringify((baseline.plan.candidates ?? []).find(c => c.stationId === 50));
    // make station 50's plugs occupied-but-working
    const original = (statiq as unknown as { detailsWithMeta: (id: number) => Promise<{ response: StatiqDetailsResponse }> }).detailsWithMeta;
    (statiq as unknown as Record<string, unknown>).detailsWithMeta = async (id: number) => {
      const res = await original(id);
      if (id === 50 && res.response.station?.chargers[0]) {
        res.response.station.chargers[0] = {
          ...res.response.station.chargers[0],
          connectors: [
            { displayId: 1, connectorId: 5001, type: 'CCS-2', status: 'charging', available: false, note: 'Charging' },
          ],
        } as never;
      }
      return res;
    };
    const bundle = await planTripDetailed(
      { router: fakeRouter(700), statiq },
      O,
      D(700),
      { includeCandidates: true },
    );
    const cands = bundle.plan.candidates ?? [];
    expect(cands.length).toBeGreaterThan(0);
    // Bound any occupancy/health leak to forbidden FIELD NAMES and exact
    // occupancy VALUES, never to a prose substring (the honest explicit
    // reliabilityNote legitimately contains the word 'available').
    const forbiddenKeys = new Set([
      'status', 'available', 'availability', 'plugs', 'connectors', 'occupancy',
      'occupied', 'charging', 'working-free', 'working-occupied',
      'plugStatus', 'connectorStatus', 'occupancyStatus',
    ]);
    const occupancyValues = new Set([
      'available', 'charging', 'occupied', 'faulted', 'unavailable',
      'preparing', 'finishing', 'working-free', 'working-occupied', 'busy',
    ]);
    const auditNoOccupancy = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(auditNoOccupancy); return; }
      if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          expect(forbiddenKeys.has(key)).toBe(false);
          if (typeof nested === 'string') expect(occupancyValues.has(nested.toLowerCase())).toBe(false);
          auditNoOccupancy(nested);
        }
      }
    };
    auditNoOccupancy(cands);
    // fields it does get
    const sample = cands[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sample).sort()).toEqual([
      'brand', 'chainageKm', 'city', 'evidence', 'maxKw', 'name',
      'offRouteKm', 'pricePerKwh', 'rating', 'reviewCount', 'stationId',
    ]);
    const evidence = sample.evidence as Record<string, unknown>;
    expect(evidence.fetchedAt).toBeTruthy();
    expect(evidence.hours).toBe('00:00 To 23:59');
    expect(evidence.openText).toBe('Open Now');
    const projected50 = JSON.stringify((bundle.plan.candidates ?? []).find(c => c.stationId === 50));
    // Two sequential live runs legitimately carry fetchedAt values a few ms
    // apart. Normalize ONLY that timestamp; every other nested field stays an
    // exact deep-invariance assertion (no production freshness change).
    const withoutFetchedAt = (raw: string): string =>
      raw.replace(/"fetchedAt":"[^"]*"/g, '"fetchedAt":"<normalized>"');
    expect(withoutFetchedAt(projected50)).toBe(withoutFetchedAt(baselineProjection));
    const chargers = evidence.chargers as Array<Record<string, unknown>>;
    expect(chargers[0]?.lastUsedOn).toBe('19/11/2026');
    expect(evidence.accessType).toBe('public');
    expect(evidence.reliability).toBeNull();
    expect(evidence.reliabilityNote).toBe('No verified reliability score is available.');
    expect(JSON.stringify(evidence)).not.toMatch(/"(charging|occupied|available|status|plugs)"/i);
  });
});

it('AI rebuild charges the final stop from geometry chainage, not OSRM metadata', () => {
  const geometryKm = 700;
  const bundle = handBuiltBundle([300, 550], geometryKm);
  // OSRM metadata can differ from the geometry chainage used for validation.
  bundle.plan.routeDistanceKm = 650;
  const validation = validateAiChoice(bundle, { stationIds: [idAt(300), idAt(550)] }, {}, HARIER_EV_75);
  expect(validation.ok).toBe(true);
  if (!validation.ok) return;
  const plan = assembleAiPlan(bundle, validation.seq, { applied: true }, {}, HARIER_EV_75);

  const geometryTotalKm = routeLengthKmForTest(bundle.route.geometry);
  const last = plan.stops.at(-1)!;
  const finalLegKm = geometryTotalKm - last.chainageKm + last.detourKm;
  const buffer = DEFAULT_PLAN_OPTIONS.minArrivalSocPct + 2;
  const expectedArriveSoc = buffer;
  const expectedLeaveSoc = socRequiredForArrival(finalLegKm, buffer, HARIER_EV_75);
  const expectedChargeKwh = kwhForSocDelta(expectedArriveSoc, expectedLeaveSoc, HARIER_EV_75);
  const expectedDestinationSoc = Math.round(socAfterDriving(finalLegKm, expectedLeaveSoc, HARIER_EV_75));

  expect(plan.totals.distanceKm).toBeCloseTo(geometryTotalKm, 6);
  expect(last.arriveSocPct).toBeCloseTo(Math.round(expectedArriveSoc * 10) / 10, 1);
  expect(last.leaveSocPct).toBeCloseTo(Math.round(expectedLeaveSoc * 10) / 10, 1);
  expect(last.chargeKwh).toBeCloseTo(Math.round(expectedChargeKwh * 10) / 10, 1);
  expect(plan.totals.finalSocPct).toBe(expectedDestinationSoc);

  // Counterfactual: the previous metadata-based rebuild charged a 100 km
  // final leg from a 650 km total. It produced a materially different final
  // stop, so these assertions fail if that distance source is restored.
  const metadataLast = finalize(
    validation.seq, bundle.plan.routeDistanceKm, bundle.route, DEFAULT_PLAN_OPTIONS, HARIER_EV_75, [],
  ).at(-1)!;
  const metadataFinalLegKm = bundle.plan.routeDistanceKm - metadataLast.chainageKm + metadataLast.detourKm;
  const metadataExpectedLeave = socRequiredForArrival(metadataFinalLegKm, buffer, HARIER_EV_75);
  expect(metadataFinalLegKm).toBeLessThan(finalLegKm - 40);
  expect(metadataLast.leaveSocPct).toBeCloseTo(Math.round(metadataExpectedLeave * 10) / 10, 1);
  expect(metadataLast.chargeKwh).toBeLessThan(last.chargeKwh);
});

it('AI alternatives inherit degraded numeric evidence and unknown cost without reintroducing bad candidates', async () => {
  const base = fakeStatiq(stations);
  const brokenId = stations[2]!.id;
  const statiq = { ...base, detailsWithMeta: async (id: number) => {
    const result = await base.detailsWithMeta(id);
    if (result.response.station) Object.assign(result.response.station.chargers[0]!, { kw: id === brokenId ? 0 : 60, pricePerKwh: -20 });
    return result;
  } } as unknown as StatiqClient;
  const bundle = await planTripDetailed({ router: fakeRouter(700), statiq }, O, D(700));
  expect(bundle.plan.status).toBe('degraded');
  expect(bundle.usableCandidates.some(candidate => candidate.candidate.stationId === brokenId)).toBe(false);
  const validation = validateAiChoice(bundle, { stationIds: bundle.plan.stops.map(stop => stop.station.stationId) }, {}, HARIER_EV_75);
  expect(validation.ok).toBe(true); if (!validation.ok) return;
  const plan = assembleAiPlan(bundle, validation.seq, { applied: true }, {}, HARIER_EV_75);
  expect(plan.status).toBe('degraded'); expect(plan.totals.estPriceInr).toBeNull();
  expect(Number.isFinite(plan.totals.totalTimeMin)).toBe(true);
  expect(plan.warnings.join(' ')).toContain('power is invalid');
});
