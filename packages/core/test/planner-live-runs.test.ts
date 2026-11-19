/**
 * Planner runs over a REAL budgeted StatiqClient (wire-shaped fake
 * transport): finite-pool candidate accounting and fail-closed stops.
 *
 * These complement the duck-typed planner tests: here planTripDetailed
 * attaches the shared UpstreamBudget to a real client, so every transport
 * attempt (the markers scan + each individual per-station lookup) is
 * reserved and enforced the way production live runs are.
 *
 * Invariants proven:
 * - finite pool: every UNIQUE candidate gets exactly ONE per-station
 *   lookup, regardless of how many corridor samples saw it; a workable
 *   route plans fine within the attempt budget;
 * - the FIRST 429 in the details phase stops the whole run: exactly four
 *   lookups dispatched (three ok + one throttled), zero traffic after,
 *   honest not_determined evidence (samples covered, candidates
 *   processed/planned/remaining, Retry-After, attempt count);
 * - attempt-cap exhaustion refuses the next dispatch BEFORE any traffic;
 * - a deadline abort mid-details fails as an honest not_determined.
 */
import { describe, expect, it } from 'vitest';
import { planTrip, PlanningError } from '../src/planner.js';
import { StatiqClient } from '../src/statiq.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type {
  StatiqCharger,
  StatiqDetailsResponse,
  StatiqMarkersResponse,
  StatiqStationDetail,
} from '../src/types.js';

const KM_PER_DEG = 111.32;
/** Fast limiter: keep the shared pacing machinery but at test speed. */
const FAST = { minCallGapMs: 1, maxCallsPerMinute: 10_000 } as const;
/** Gap-less limiter for the deadline test: markers dispatch in a burst so
 *  the deadline lands deterministically inside the details phase. */
const BURST = { minCallGapMs: 0, maxCallsPerMinute: 10_000 } as const;

/** Straight-line northwards route of the given length. */
function makeRoute(totalKm: number): RouteResult {
  const n = Math.max(2, Math.ceil(totalKm / 10));
  const geometry = Array.from({ length: n + 1 }, (_, i) => ({
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
  offRouteKm?: number;
  kw?: number;
  pricePerKwh?: number | null;
}

function stationDetail(spec: StationSpec): StatiqStationDetail {
  const chargers: StatiqCharger[] = [
    {
      chargerId: spec.id * 10 + 1,
      name: `${spec.name} DC`,
      type: 'DC',
      kw: spec.kw ?? 60,
      pricePerKwh: spec.pricePerKwh ?? 20,
      currency: 'INR',
      lastUsedOn: '19/11/2026',
      connectors: [
        {
          displayId: 1,
          connectorId: spec.id * 100 + 1,
          type: 'CCS-2',
          status: 'available',
          available: true,
          note: null,
        },
      ],
    },
  ];
  return {
    stationId: spec.id,
    name: spec.name,
    lat: spec.chainageKm / KM_PER_DEG,
    lon: (spec.offRouteKm ?? 0) / KM_PER_DEG,
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

/** One recorded upstream attempt for exactness assertions. */
interface RecordedCall {
  endpoint: 'markers' | 'details';
  stationId?: number;
}

interface DetailsBehavior {
  /** Non-200 overrides the response; 200 (default) serves the station. */
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Simulated per-lookup latency before responding. */
  delayMs?: number;
}

interface WireOpts {
  specs: StationSpec[];
  /** Per-station lookup behavior (null/undefined = normal 200). */
  detailsBehavior?: (stationId: number, dispatch: number) => DetailsBehavior | null;
}

/**
 * Wire-shaped fake transport behind a REAL StatiqClient: markers respond
 * with the finite pool around the sampled chainage; details respond per
 * station (behavior can inject 429s / latency). Both routes record every
 * attempt. The limiter serializes dispatch order via its slot queue, so
 * "dispatch N" counting is deterministic.
 */
function wireStatiq(
  opts: WireOpts,
  limiter: { minCallGapMs: number; maxCallsPerMinute: number } = FAST,
): { client: StatiqClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let detailsDispatch = 0;
  const details = new Map<number, StatiqStationDetail>(
    opts.specs.map((s) => [s.id, stationDetail(s)]),
  );
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    const bodyText = String(init?.body ?? '');
    if (path.endsWith('/stations/markers')) {
      calls.push({ endpoint: 'markers' });
      const { latitude } = JSON.parse(bodyText) as { latitude: number };
      const centerKm = latitude * KM_PER_DEG;
      const stations = opts.specs
        .filter((s) => Math.abs(s.chainageKm - centerKm) <= 13)
        .map((s) => ({
          stationId: s.id,
          name: s.name,
          lat: s.chainageKm / KM_PER_DEG,
          lon: (s.offRouteKm ?? 0) / KM_PER_DEG,
          address: null,
          accessType: 1,
          isCommunityListed: false,
          stationUrl: '',
        }));
      const markers: StatiqMarkersResponse = {
        ok: true,
        live: true,
        retained: false,
        source: 'test',
        count: stations.length,
        stations,
      };
      return new Response(JSON.stringify(markers), { status: 200 });
    }
    if (path.endsWith('/stations/details')) {
      const dispatch = ++detailsDispatch;
      const { station_id } = JSON.parse(bodyText) as { station_id: number };
      calls.push({ endpoint: 'details', stationId: station_id });
      const behavior = opts.detailsBehavior?.(station_id, dispatch) ?? null;
      if (behavior?.delayMs) {
        await new Promise((r) => setTimeout(r, behavior.delayMs));
      }
      const status = behavior?.status ?? 200;
      if (status !== 200) {
        return new Response(behavior?.body ?? '{"error":"nope"}', {
          status,
          headers: new Headers(behavior?.headers ?? {}),
        });
      }
      const response: StatiqDetailsResponse = {
        ok: true,
        live: true,
        retained: false,
        source: 'test',
        station: details.get(station_id) ?? null,
      };
      return new Response(JSON.stringify(response), { status: 200 });
    }
    return new Response('{"error":"unknown route"}', { status: 404 });
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'wire-test',
    fetchImpl: impl,
    minCallGapMs: limiter.minCallGapMs,
    maxCallsPerMinute: limiter.maxCallsPerMinute,
  });
  return { client, calls };
}

/** 700 km route with 8 unique candidates every 80 km (finite pool). */
const POOL: StationSpec[] = Array.from({ length: 8 }, (_, i) => ({
  id: 100 + i,
  name: `Wire Statiq ${i}`,
  chainageKm: 80 * (i + 1),
  offRouteKm: 0,
}));

const O = { label: 'Origin', lat: 0, lon: 0 };
const D700 = { label: 'Destination', lat: 700 / KM_PER_DEG, lon: 0 };

/** markers samples for a corridor scan of `totalKm` (12 km step + destination). */
function expectedMarkerCalls(totalKm: number): number {
  return Math.ceil(totalKm / 12) + 1;
}

function expectPlanningError(err: unknown): asserts err is PlanningError {
  expect(err).toBeInstanceOf(PlanningError);
}

describe('planner runs over a real budgeted client (wire transport)', () => {
  it('checks every unique candidate in the finite pool exactly once', async () => {
    const { client, calls } = wireStatiq({ specs: POOL });
    // 700 km > 300 km safe range: the plan needs (and finds) stops
    const plan = await planTrip({ router: fakeRouter(700), statiq: client }, O, D700);
    expect(plan.stops.length).toBeGreaterThanOrEqual(1);
    expect(plan.status).toBe('ok');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // every planned corridor sample was dispatched exactly once
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    // EVERY unique candidate got exactly ONE individual per-station lookup:
    // marker-sample overlap never duplicates lookups (within-run dedupe)
    expect(details).toHaveLength(POOL.length);
    const detailIds = details.map((c) => c.stationId).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(new Set(detailIds).size).toBe(POOL.length);
    expect(detailIds).toEqual(POOL.map((s) => s.id).sort((a, b) => a - b));
    // honest totals: all attempts accounted (markers + details, no retries)
    expect(calls).toHaveLength(expectedMarkerCalls(700) + POOL.length);
  });

  it('a first 429 in the details phase stops the whole run: zero traffic after', async () => {
    const { client, calls } = wireStatiq({
      specs: POOL,
      detailsBehavior: (_id, dispatch) =>
        dispatch <= 3
          ? null // first three lookups succeed
          : {
              status: 429,
              headers: { 'Retry-After': '30' },
              body: '{"error":"Please wait a minute."}',
            },
    });
    const err = await planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
    ).catch((e) => e);
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('throttled');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // the run had scanned the whole route, then the 4th per-station lookup
    // was throttled - and NOTHING was dispatched after it
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    expect(details).toHaveLength(4);
    expect(calls).toHaveLength(expectedMarkerCalls(700) + 4);

    // honest evidence: samples covered, candidates processed/planned with
    // remaining, the demanded Retry-After, and the attempt count
    expect(err.message).toContain('route samples covered 60/60');
    expect(err.message).toContain('candidates processed 3/8');
    expect(err.message).toContain('asked to wait 30s');
    expect(err.message).toContain(`after ${expectedMarkerCalls(700) + 4} of 220`);
  });

  it('attempt-cap exhaustion refuses the next dispatch before any traffic', async () => {
    // 60 marker samples + 3 successful lookups = exactly the cap
    const { client, calls } = wireStatiq({ specs: POOL });
    const err = await planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
      {
        runBudget: {
          deadlineMs: 60_000,
          maxUpstreamCalls: expectedMarkerCalls(700) + 3,
        },
      },
    ).catch((e) => e);
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('budget-exhausted');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    // the 4th lookup was REFUSED pre-dispatch: never touched the network
    expect(details).toHaveLength(3);
    expect(calls).toHaveLength(expectedMarkerCalls(700) + 3);

    // evidence names the cap and the processed/planned/remaining aggregate
    expect(err.message).toContain(
      `budget of ${expectedMarkerCalls(700) + 3} upstream attempts`,
    );
    expect(err.message).toContain('candidates processed 3/8');
    expect(err.message).toContain('5 remaining');
  });

  it('a deadline abort mid-details fails as an honest not_determined', async () => {
    // Deterministic shape: gap-less limiter => the 60-marker burst finishes
    // in milliseconds; every per-station lookup takes 120ms; the deadline
    // (100ms) therefore lands with the first four lookups in flight (all
    // dispatched immediately by the 4 workers) and candidates 5..8 still
    // waiting - their acquireSlot sees the aborted signal and the run
    // unwinds as not_determined:deadline.
    const { client, calls } = wireStatiq(
      {
        specs: POOL,
        detailsBehavior: () => ({ delayMs: 120 }),
      },
      BURST,
    );
    const err = await planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
      { runBudget: { deadlineMs: 100, maxUpstreamCalls: 1_000 } },
    ).catch((e) => e);
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('deadline');
    expect(err.message).toContain('time budget');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // scan burst completed; the only lookups dispatched were the first four
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    expect(details).toHaveLength(4);
  });
});
