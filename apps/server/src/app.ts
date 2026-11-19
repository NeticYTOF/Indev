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
  type PlanRunBudget,
  type ResolvedVehicle,
  type TripPlan,
  type VehicleSelection,
} from '@indeev/core';
import { planTripDetailed, validateAiChoice, assembleAiPlan, type PlanBundle } from '@indeev/core';
import { chatCompletion, parseChoiceJson, AiProviderError } from './ai-provider.js';

export interface AppDeps {
  /** Creates a fresh Statiq client for one planning run. The optional
   *  opts carry an EXPLICIT per-launch retry override (env-configured);
   *  implementations accept and ignore extras for compatibility. */
  createStatiq: (opts?: { retries?: number }) => StatiqClient;
  router: OsrmRouter;
  geocoder: PhotonGeocoder;
  trips: TripsStore;
  counters: CountersStore;
  mock: boolean;
  /** Sanitized run-completion hook: outcome + upstream call count only. */
  onRunComplete?: (outcome: string, upstreamCalls: number) => void;
  /** AI planning config: all three set = enabled. Off by default. */
  ai?: { baseUrl: string; apiKey: string; model: string };
  /** Injectable for tests; defaults to the real provider call. */
  aiCall?: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<string>;
  /**
   * EXPLICIT bounded planning-budget override (operator-supplied, e.g. for
   * a coordinated acceptance). Absent = SERVER_RUN_BUDGET defaults,
   * byte-identical to before; present = validated by loadEnv at boot.
   * Never raised automatically - only an explicit launch choice.
   */
  planRunBudget?: PlanRunBudget;
  /** Explicit per-launch client retry override (0..3, validated); the
   *  StatiqClient default (2) applies when absent. */
  statiqRetries?: number;
  /**
   * Per-launch instance identity (a launcher-generated UUID): echoed in
   * /api/health as `launchId` so a launcher can gate on ITS OWN server
   * instance. NOT a credential; absent = null in health (plain dev
   * launches need no identity). This is the provenance gate that killed
   * the unrelated-same-mode-server acceptance race.
   */
  launchId?: string;
}

/** Server-side bounds for a planning request. */
export const SERVER_RUN_BUDGET = { deadlineMs: 4 * 60_000, maxUpstreamCalls: 200 };

const PLANNING_CODE_TO_STATUS: Record<string, number> = {
  not_determined: 422,
  no_route: 422,
  infeasible: 422,
};

/**
 * Fine-grained audit outcome for a planning error: code plus cause when we
 * have one (e.g. not_determined:throttled, not_determined:budget-exhausted)
 * so throttled runs stay distinguishable from coverage holes afterwards.
 */
function auditOutcomeFor(err: unknown): string {
  if (err instanceof PlanningError) {
    return err.cause ? `${err.code}:${err.cause}` : err.code;
  }
  return 'error';
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // The EFFECTIVE planning budget: the explicit bounded override when the
  // operator supplied one (validated at boot), else the server default.
  const runBudget = deps.planRunBudget ?? SERVER_RUN_BUDGET;
  const statiqRetries = deps.statiqRetries;

  app.onError((err, c) => {
    if (err instanceof PlanningError) {
      const status = PLANNING_CODE_TO_STATUS[err.code] ?? 422;
      // The fine-grained cause travels in the HTTP body too, not just the
      // audit outcome: the UI needs it to give cause-true guidance (a
      // budget-exhausted run is NOT "the API is throttling - retry now").
      // Absent for cause-less errors (no_route, infeasible).
      return c.json(
        { error: err.message, code: err.code, ...(err.cause ? { cause: err.cause } : {}) },
        status as never,
      );
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
      ai: Boolean(deps.ai),
      // INSTANCE PROVENANCE: the launcher-generated launch id echoed back so
      // a launcher can prove this health answer came from its OWN child (a
      // random UUID per launch - sanitized, never a credential)
      launchId: deps.launchId ?? null,
      // Sanitized introspection (no secrets): the effective planning
      // envelope this server was launched with
      runBudget: {
        maxUpstreamCalls: runBudget.maxUpstreamCalls,
        deadlineMs: runBudget.deadlineMs,
        retries: statiqRetries ?? 2, // 2 = the StatiqClient default
      },
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
    const all = await deps.geocoder.search(q.trim(), 8);
    // India-first: if any India hit exists, drop foreign ones (this is an
    // India route planner); then dedupe by place identity.
    const indian = all.filter((h) => h.country === 'India');
    const pool = indian.length > 0 ? indian : all;
    const seen = new Set<string>();
    const hits = pool.filter((h) => {
      const key = `${h.name}::${h.lat.toFixed(3)},${h.lon.toFixed(3)}::${h.state ?? ''}::${h.city ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return c.json({ hits: hits.slice(0, 6) });
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

    // Vehicle selection (real-world range separation, never invented) -
    // resolved BEFORE the mock branch so synthetic plans echo the request
    // vehicle truthfully and validation errors behave identically in both
    // modes.
    let resolved: ResolvedVehicle;
    try {
      resolved = resolveVehicle(b.vehicle);
    } catch (err) {
      if (err instanceof VehicleSelectionError) throw err;
      throw err;
    }

    if (deps.mock) {
      const plan = mockPlan(origin, destination, resolved);
      await deps.counters.addChargersSeen(plan.stationsSeen);
      // synthetic plans make zero upstream calls; the run audit stays honest
      deps.onRunComplete?.('ok', 0);
      return c.json({ plan });
    }

    const statiq = deps.createStatiq({ retries: statiqRetries });
    const options: PlanOptions = {
      startSocPct: clampSoc(b.startSocPct),
      runBudget,
    };
    try {
      const plan = await planTrip(
        { router: deps.router, statiq, vehicle: resolved.config, resolvedVehicle: resolved },
        origin,
        destination,
        options,
      );
      // Persist only the running count of chargers seen; never station data.
      await deps.counters.addChargersSeen(plan.stationsSeen);
      deps.onRunComplete?.('ok', statiq.upstreamCallsMade());
      return c.json({ plan });
    } catch (err) {
      deps.onRunComplete?.(auditOutcomeFor(err), statiq.upstreamCallsMade());
      throw err;
    }
  });

  app.post('/api/ai/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    const b = body as {
      origin?: { label?: string; lat?: number; lon?: number };
      destination?: { label?: string; lat?: number; lon?: number };
      vehicle?: VehicleSelection;
      startSocPct?: number;
      request?: string;
    } | null;
    const origin = coordRef(b?.origin);
    const destination = coordRef(b?.destination);
    if (!origin || !destination) {
      return c.json(
        { error: 'origin and destination each need label, lat and lon', code: 'bad_request' },
        400,
      );
    }

    // Vehicle selection resolves first in ALL modes (mock echoes it).
    let resolved: ResolvedVehicle;
    try {
      resolved = resolveVehicle(b?.vehicle);
    } catch (err) {
      if (err instanceof VehicleSelectionError) throw err;
      throw err;
    }

    // MOCK MODE: even an explicitly configured AI must never reach upstream.
    // Serve the same synthetic plan /api/plan would, with an honest label.
    if (deps.mock) {
      const plan = mockPlan(origin, destination, resolved);
      await deps.counters.addChargersSeen(plan.stationsSeen);
      deps.onRunComplete?.('ok', 0);
      return c.json({
        plan,
        ai: {
          applied: false,
          reason: 'Synthetic plan (mock mode): AI planning is unavailable and never reaches live upstream.',
        },
      });
    }

    // AI planning is OFF unless AI_BASE_URL + AI_API_KEY + AI_MODEL are set.
    if (!deps.ai) {
      return c.json(
        { error: 'AI planning is disabled on this server (no AI provider configured).', code: 'ai_disabled' },
        503 as never,
      );
    }
    const customRequest =
      typeof b?.request === 'string' && b.request.trim() ? b.request.trim().slice(0, 2000) : undefined;

    const statiq = deps.createStatiq({ retries: statiqRetries });
    // Keep the request's starting charge through validation and rebuilding.
    // Omit undefined so the core's default100% remains the default only
    // when no valid starting charge was supplied.
    const startSocPct = clampSoc(b?.startSocPct);
    const planOptions: PlanOptions = {
      runBudget,
      ...(startSocPct === undefined ? {} : { startSocPct }),
    };
    // 1) base plan + AI-safe candidates (no occupancy anywhere).
    //    Audit the base-plan run on failure too: a not_determined base plan
    //    (throttle/budget/deadline) must surface in the run audit, not vanish.
    let bundle: PlanBundle;
    try {
      bundle = await planTripDetailed(
        { router: deps.router, statiq, vehicle: resolved.config, resolvedVehicle: resolved },
        origin,
        destination,
        {
          ...planOptions,
          includeCandidates: true,
        },
      );
    } catch (err) {
      deps.onRunComplete?.(auditOutcomeFor(err), statiq.upstreamCallsMade());
      throw err;
    }
    await deps.counters.addChargersSeen(bundle.plan.stationsSeen);

    // 2) ask the model to pick the stop sequence from the candidates
    const system =
      'You are an EV trip-planning assistant for India. You receive a computed base plan ' +
      'and its candidate charging stations. Choose the best stop sequence respecting: ' +
      'legs at most 300 km, fewest stops, brands preferred in order Statiq > Tata > BPCL > HP > others. ' +
      'You may keep the base sequence if it is already best. Respond with STRICT JSON only: ' +
      '{"chosenStationIds": number[], "notes": string}. chosenStationIds must be the station ids in ' +
      'route order, drawn only from the provided candidates. notes is one short sentence for the user.';
    const user = JSON.stringify({
      vehicle: {
        label: bundle.plan.vehicle.label,
        batteryKwh: bundle.plan.vehicle.batteryKwh,
        claimedRangeKm: bundle.plan.vehicle.claimedRangeKm,
        realWorldRangeKm: bundle.plan.vehicle.realWorldRangeKm,
      },
      basePlan: {
        stopIds: bundle.plan.stops.map((s) => s.station.stationId),
        stopNames: bundle.plan.stops.map((s) => s.station.name),
        distanceKm: Math.round(bundle.plan.routeDistanceKm),
        totalTimeMin: Math.round(bundle.plan.totals.totalTimeMin),
      },
      candidates: bundle.plan.candidates ?? [],
      userRequest: customRequest ?? null,
    });

    try {
      const content = deps.aiCall
        ? await deps.aiCall([{ role: 'system', content: system }, { role: 'user', content: user }])
        : (
            await chatCompletion(deps.ai, [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ])
          ).content;
      const { stationIds, notes } = parseChoiceJson(content);

      if (!stationIds || stationIds.length === 0) {
        deps.onRunComplete?.('ai-invalid', statiq.upstreamCallsMade());
        return c.json({
          plan: bundle.plan,
          ai: { applied: false, reason: 'The AI returned no stop sequence; showing the computed plan.' },
        });
      }

      const validation = validateAiChoice(bundle, { stationIds, notes }, planOptions, resolved.config);
      if (!validation.ok) {
        deps.onRunComplete?.('ai-invalid', statiq.upstreamCallsMade());
        return c.json({
          plan: bundle.plan,
          ai: { applied: false, reason: `The AI choice was rejected (${validation.reason}). Showing the computed plan.` },
        });
      }

      const rebuilt = assembleAiPlan(bundle, validation.seq, { applied: true, notes }, planOptions, resolved.config);
      deps.onRunComplete?.('ok', statiq.upstreamCallsMade());
      return c.json({ plan: rebuilt, ai: { applied: true, notes } });
    } catch (err) {
      const reason =
        err instanceof AiProviderError || err instanceof PlanningError || err instanceof SyntaxError
          ? err.message
          : 'The AI provider failed; showing the computed plan.';
      deps.onRunComplete?.('ai-error', statiq.upstreamCallsMade());
      return c.json({
        plan: bundle.plan,
        ai: { applied: false, reason },
      });
    }
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
      if (!s || !s.station || typeof s.station !== 'object' || !Number.isInteger(s.station.stationId) || s.station.stationId <= 0) {
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
    // Saved routes must be redrawable. Reject the whole malformed path;
    // never discard points or fabricate replacement geometry.
    if (plan.geometry.length < 2 || plan.geometry.some((point) => !coordRef(point))) {
      return c.json({ error: 'Plan geometry is malformed', code: 'bad_request' }, 400);
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
    // Per-launch retry override applies here too (client behavior); the
    // plan budget override does not (single-call revalidation has no run).
    const statiq = deps.createStatiq({ retries: statiqRetries });
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
    o.lat >= -90 && o.lat <= 90 &&
    typeof o.lon === 'number' &&
    Number.isFinite(o.lon) &&
    o.lon >= -180 && o.lon <= 180
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
  resolved: ResolvedVehicle,
): TripPlan {
  const now = new Date().toISOString();
  return {
    id: `mock-${Date.now()}`,
    createdAt: now,
    origin,
    destination,
    vehicle: {
      label: resolved.label,
      catalogId: resolved.catalogId,
      batteryKwh: resolved.batteryKwh,
      claimedRangeKm: resolved.claimedRangeKm,
      realWorldRangeKm: resolved.realWorldRangeKm,
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
