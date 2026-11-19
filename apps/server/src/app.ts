/**
 * IndEV HTTP API.
 *
 * - One fresh StatiqClient per planning run (single-run memo policy).
 * - Every planning run is bounded: server run budget (deadline + upstream
 *   call cap), so a request can never hold the turn indefinitely.
 * - Saved trips are minimal (station refs + geometry); station data is
 *   always fetched live when viewed.
 * - Mock mode (INDEV_MOCK=1) serves synthetic plans/stations so UI work and
 *   repeatable UI tests never touch the live upstream.
 * - The bearer token lives only in the Statiq clients; it is never logged
 *   and never appears in any response.
 */
import { Hono } from 'hono';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  TripsStore,
  VehicleSelectionError,
  planTrip,
  resolveVehicle,
  VEHICLE_CATALOG,
  summarizeCcs2,
  DEFAULT_HARRIER_ENTRY_ID,
  type PlanOptions,
  type ResolvedVehicle,
  type TripPlan,
  type VehicleSelection,
} from '@indeev/core';

export interface AppDeps {
  /** Creates a fresh Statiq client for one planning run. */
  createStatiq: () => StatiqClient;
  router: OsrmRouter;
  geocoder: PhotonGeocoder;
  trips: TripsStore;
  counters: CountersStore;
  mock: boolean;
}

/** Server-side bounds for a planning request. */
export const SERVER_RUN_BUDGET = { deadlineMs: 4 * 60_000, maxUpstreamCalls: 200 };

const PLANNING_CODE_TO_STATUS: Record<string, number> = {
  not_determined: 422,
  no_route: 422,
  infeasible: 422,
  budget: 504,
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof PlanningError) {
      const status = PLANNING_CODE_TO_STATUS[err.code] ?? 422;
      return c.json({ error: err.message, code: err.code }, status as never);
    }
    if (err instanceof VehicleSelectionError) {
      return c.json({ error: err.message, code: 'bad_vehicle' }, 400);
    }
    console.error('Unhandled server error:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Internal error', code: 'internal' }, 500);
  });

  app.get('/api/health', async (c) => {
    const counters = await deps.counters.load();
    return c.json({
      ok: true,
      mock: deps.mock,
      chargersSeen: counters.chargersSeen,
    });
  });

  app.get('/api/vehicles', (c) => {
    // Claims are explicitly labelled; real-world range is user input only.
    return c.json({
      default: DEFAULT_HARRIER_ENTRY_ID,
      catalog: VEHICLE_CATALOG,
      note: 'claimedRangeKm values are manufacturer claims (MIDC/ARAI), not real-world range.',
    });
  });

  app.get('/api/geocode', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length < 2) {
      return c.json({ hits: [] });
    }
    if (deps.mock) {
      return c.json({ hits: mockGeocode(q) });
    }
    const hits = await deps.geocoder.search(q.trim(), 6);
    return c.json({ hits });
  });

  app.post('/api/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body', code: 'bad_request' }, 400);
    }
    const b = body as {
      origin?: { label?: string; lat?: number; lon?: number };
      destination?: { label?: string; lat?: number; lon?: number };
      vehicle?: VehicleSelection;
      startSocPct?: number;
    };
    const origin = coordRef(b.origin);
    const destination = coordRef(b.destination);
    if (!origin || !destination) {
      return c.json(
        { error: 'origin and destination each need label, lat and lon', code: 'bad_request' },
        400,
      );
    }

    if (deps.mock) {
      const plan = mockPlan(origin, destination);
      await deps.counters.addChargersSeen(plan.stationsSeen);
      return c.json({ plan });
    }

    // Vehicle selection (real-world range separation, never invented).
    let resolved: ResolvedVehicle;
    try {
      resolved = resolveVehicle(b.vehicle);
    } catch (err) {
      if (err instanceof VehicleSelectionError) throw err;
      throw err;
    }

    const statiq = deps.createStatiq();
    const options: PlanOptions = {
      startSocPct: clampSoc(b.startSocPct),
      runBudget: SERVER_RUN_BUDGET,
    };
    const plan = await planTrip(
      { router: deps.router, statiq, vehicle: resolved.config, resolvedVehicle: resolved },
      origin,
      destination,
      options,
    );

    // Persist only the running count of chargers seen; never station data.
    await deps.counters.addChargersSeen(plan.stationsSeen);
    return c.json({ plan });
  });

  app.get('/api/trips', async (c) => {
    const trips = await deps.trips.list();
    return c.json({ trips });
  });

  app.get('/api/trips/:id', async (c) => {
    const trip = await deps.trips.get(c.req.param('id'));
    if (!trip) return c.json({ error: 'Trip not found', code: 'not_found' }, 404);
    return c.json({ trip });
  });

  app.post('/api/trips', async (c) => {
    const body = await c.req.json().catch(() => null);
    const plan = (body as { plan?: TripPlan; name?: string } | null)?.plan;
    if (
      !plan ||
      typeof plan !== 'object' ||
      typeof plan.id !== 'string' ||
      !plan.origin ||
      !plan.destination ||
      !Array.isArray(plan.geometry) ||
      !Array.isArray(plan.stops) ||
      !plan.totals ||
      !plan.vehicle
    ) {
      return c.json({ error: 'A live plan object is required to save a trip', code: 'bad_request' }, 400);
    }
    // sanity-check stop station refs so corrupted plans cannot be persisted
    for (const s of plan.stops) {
      if (!s || typeof s.station !== 'object' || typeof s.station.stationId !== 'number') {
        return c.json({ error: 'Plan stops are malformed', code: 'bad_request' }, 400);
      }
    }
    // PROVENANCE: the live store only accepts live plans; the mock store
    // only accepts synthetic ones. Neither store ever mixes provenance.
    const expectedSource = deps.mock ? 'synthetic' : 'live';
    if (plan.source !== expectedSource) {
      return c.json(
        {
          error: deps.mock
            ? 'Only synthetic (mock) plans can be saved to the mock store'
            : 'Only live plans can be saved to the real trip store',
          code: 'wrong_provenance',
        },
        400,
      );
    }
    const saved = await deps.trips.save(plan, (body as { name?: string }).name);
    return c.json({ trip: saved }, 201);
  });

  app.delete('/api/trips/:id', async (c) => {
    const removed = await deps.trips.remove(c.req.param('id'));
    if (!removed) return c.json({ error: 'Trip not found', code: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/stations/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'station id must be a positive integer', code: 'bad_request' }, 400);
    }
    if (deps.mock) {
      return c.json({ station: mockStation(id) });
    }
    // Always a FRESH client: station views must never come from a memo.
    const statiq = deps.createStatiq();
    const { response, fetchedAt } = await statiq.detailsWithMeta(id);
    if (!response.station) {
      return c.json({ error: 'Station not found', code: 'not_found' }, 404);
    }
    return c.json({
      station: {
        ...liveStationView(response.station),
        fetchedAt: fetchedAt.toISOString(),
      },
    });
  });

  return app;
}

function coordRef(v: unknown): { label: string; lat: number; lon: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { label?: unknown; lat?: unknown; lon?: unknown };
  if (
    typeof o.lat === 'number' &&
    Number.isFinite(o.lat) &&
    typeof o.lon === 'number' &&
    Number.isFinite(o.lon)
  ) {
    return {
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : `${o.lat.toFixed(4)}, ${o.lon.toFixed(4)}`,
      lat: o.lat,
      lon: o.lon,
    };
  }
  return null;
}

function clampSoc(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(100, Math.max(5, v));
}

/**
 * Minimal live station payload for revalidation views (rating, plugs,
 * tariff, reliability: null, fetchedAt). Plug health is derived per rules.
 */
function liveStationView(station: import('@indeev/core').StatiqStationDetail) {
  const s = station;
  const summary = summarizeCcs2(s);
  return {
    stationId: s.stationId,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    address: s.address,
    city: s.city,
    hours: s.hours,
    openText: s.openText,
    rating: s.rating ?? null,
    reviewCount: s.reviewCount ?? null,
    reliability: null, // no verified reliability score exists
    ccs2: summary,
    chargers: s.chargers?.map((ch) => ({
      chargerId: ch.chargerId,
      name: ch.name,
      type: ch.type,
      kw: ch.kw,
      pricePerKwh: ch.pricePerKwh ?? null,
      lastUsedOn: ch.lastUsedOn ?? null,
      connectors: ch.connectors?.map((p) => ({
        connectorId: p.connectorId,
        type: p.type,
        status: p.status,
        available: p.available,
        note: p.note,
      })),
    })),
    amenities: s.amenities ?? [],
    stationUrl: s.stationUrl,
    navUrl: s.navUrl,
  };
}

// ---------------------------------------------------------------------------
// Mock mode: synthetic data for repeatable UI work (zero live calls).
// ---------------------------------------------------------------------------

function mockGeocode(q: string) {
  const places = [
    { name: 'Delhi', label: 'Delhi, India', lat: 28.6139, lon: 77.209, city: 'Delhi', state: 'Delhi', country: 'India' },
    { name: 'Jaipur', label: 'Jaipur, Rajasthan, India', lat: 26.9124, lon: 75.7873, city: 'Jaipur', state: 'Rajasthan', country: 'India' },
    { name: 'Mumbai', label: 'Mumbai, Maharashtra, India', lat: 19.076, lon: 72.8777, city: 'Mumbai', state: 'Maharashtra', country: 'India' },
    { name: 'Prayagraj', label: 'Prayagraj, Uttar Pradesh, India', lat: 25.4381, lon: 81.8338, city: 'Prayagraj', state: 'Uttar Pradesh', country: 'India' },
  ];
  const needle = q.trim().toLowerCase();
  return places.filter((p) => p.name.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle));
}

function mockPlan(
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
): TripPlan {
  const now = new Date().toISOString();
  return {
    id: `mock-${Date.now()}`,
    createdAt: now,
    origin,
    destination,
    vehicle: {
      label: 'Tata Harrier EV (75 kWh)',
      catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75,
      claimedRangeKm: 627,
      realWorldRangeKm: null,
    },
    status: 'ok',
    source: 'synthetic',
    routeDistanceKm: 415.2,
    routeDurationMin: 432,
    geometry: [
      { lat: origin.lat, lon: origin.lon },
      { lat: (origin.lat + destination.lat) / 2, lon: (origin.lon + destination.lon) / 2 },
      { lat: destination.lat, lon: destination.lon },
    ],
    stops: [
      {
        station: mockStationView(9101, 'Statiq Highway Plaza', 195),
        chainageKm: 198,
        legKm: 198,
        detourKm: 0.4,
        arriveSocPct: 45,
        leaveSocPct: 52,
        chargeKwh: 5,
        pricePerKwh: 22,
        estPriceInr: 110,
        chargeTimeMin: 6,
        arrivalEtaMin: 206,
        departureEtaMin: 212,
      },
      {
        station: mockStationView(9102, 'Tata Power Charge Zone', 402),
        chainageKm: 405,
        legKm: 207,
        detourKm: 1.1,
        arriveSocPct: 46,
        leaveSocPct: 81,
        chargeKwh: 25,
        pricePerKwh: 21.5,
        estPriceInr: 538,
        chargeTimeMin: 26,
        arrivalEtaMin: 421,
        departureEtaMin: 447,
      },
    ],
    totals: {
      distanceKm: 415.2,
      driveTimeMin: 432,
      chargeTimeMin: 32,
      totalTimeMin: 464,
      chargeKwh: 30,
      estPriceInr: 648,
      finalSocPct: 64,
    },
    stationsSeen: 48,
    warnings: [],
  } as TripPlan;
}

function mockStationView(stationId: number, name: string, chainageKm: number) {
  // positions along the straight mock route for map rendering
  return {
    stationId,
    name,
    brand: name.toLowerCase().includes('tata') ? 'tata' : 'statiq',
    lat: 27.7 + chainageKm * 0.001,
    lon: 76.6 + chainageKm * 0.001,
    address: 'Highway side, NH 48',
    city: 'Kotputli',
    hours: '00:00 To 23:59',
    openText: 'Open Now',
    rating: 4.3,
    reviewCount: 128,
    reliability: null,
    fetchedAt: new Date().toISOString(),
    synthetic: true,
    amenities: ['Cafe', 'Restroom'],
    stationUrl: null,
    navUrl: null,
    chargers: [
      {
        chargerId: stationId * 10,
        name: `${name} DC 60`,
        type: 'DC',
        kw: 60,
        pricePerKwh: 22,
        lastUsedOn: '18/11/2026',
        plugs: [
          { connectorId: stationId * 100 + 1, type: 'CCS-2', health: 'working-free', contradiction: false },
          { connectorId: stationId * 100 + 2, type: 'CCS-2', health: 'working-occupied', contradiction: false },
        ],
      },
    ],
  };
}

function mockStation(id: number) {
  return {
    ...mockStationView(id, 'Statiq Mock Point', 120),
    ccs2: { total: 2, usable: 2, free: 1, occupied: 1, uncertain: 0, faulted: 0, offline: 0, maxKw: 60, pricePerKwh: 22, hasContradiction: false, isUsable: true },
  };
}
