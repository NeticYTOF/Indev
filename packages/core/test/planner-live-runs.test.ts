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
import { endpointRouter } from './support/road-fixture.js';

const KM_PER_DEG = 111.32;
/** Fast limiter: keep the shared pacing machinery but at test speed. */
const FAST = { minCallGapMs: 1, maxCallsPerMinute: 10_000 } as const;

/** Straight-line northwards route of the given length. */
function makeRoute(totalKm: number): RouteResult {
  const n = Math.max(2, Math.ceil(totalKm / 10));
  const geometry = Array.from({ length: n + 1 }, (_, i) => ({
    lat: (totalKm / KM_PER_DEG) * (i / n),
    lon: 0,
  }));
  return { distanceKm: totalKm, durationMin: totalKm, geometry };
}

function fakeRouter(_totalKm: number): OsrmRouter {
  return endpointRouter();
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
  /** First transport call per MARKER SAMPLE POINT -> 500, subsequent -> 200
   *  (drives in-client retries; the client's default retries: 2 covers it). */
  markerAttemptFailOnce?: boolean;
  /** First transport call per STATION ID -> 500, subsequent -> 200. */
  detailAttemptFailOnce?: boolean;
  /** CONTROLLED PENDING MARKER RESPONSES: marker calls NEVER complete on
   *  their own - each rejects with a fetch-shaped AbortError exactly when
   *  its request's abort signal fires (the run deadline). This gives
   *  deadline fixtures a deterministic mid-scan shape with exact counts:
   *  the wall-clock latency racing that plagued the earlier markerDelayMs
   *  design is gone (with the corridor's 4 concurrent workers, a 10ms
   *  transport delay let the whole 60-sample scan finish before a 200ms
   *  deadline). */
  markerPendingUntilAbort?: boolean;
  /** The FIRST markers transport call throws the exact AbortError shape
   *  the per-request timeout controller produces (with the outer run
   *  signal LIVE): the 685e7b9 contract classifies it as a RETRYABLE
   *  transport failure, not a cancellation. A mid-scan timeout fixture
   *  with exact counts - had the misclassification remained, the run
   *  would abort as a false deadline (zero details dispatched). */
  markerTimeoutFirstCall?: boolean;
}

/**
 * Wire-shaped fake transport behind a REAL StatiqClient: markers respond
 * with the finite pool around the sampled chainage; details respond per
 * station (behavior can inject 429s / latency / fail-once retries). Both
 * routes record every attempt. The client runs on an ADVANCING FAKE CLOCK
 * (limiter gaps and backoffs are instant real-time but still ordered via
 * the slot queue, so "dispatch N" counting is deterministic); transport
 * `delayMs` is a REAL timer, unaffected by the fake clock.
 */
function wireStatiq(
  opts: WireOpts,
  limiter: { minCallGapMs: number; maxCallsPerMinute: number } = FAST,
): { client: StatiqClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let detailsDispatch = 0;
  let markerDispatch = 0;
  let nowMs = 0; // advancing fake clock (deterministic; no real sleeps)
  const markerAttempts = new Map<string, number>();
  const detailAttempts = new Map<number, number>();
  const details = new Map<number, StatiqStationDetail>(
    opts.specs.map((s) => [s.id, stationDetail(s)]),
  );
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    const bodyText = String(init?.body ?? '');
    if (path.endsWith('/stations/markers')) {
      calls.push({ endpoint: 'markers' });
      const dispatchIdx = ++markerDispatch;
      const { latitude, longitude } = JSON.parse(bodyText) as {
        latitude: number;
        longitude: number;
      };
      const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const seen = (markerAttempts.get(key) ?? 0) + 1;
      markerAttempts.set(key, seen);
      // CONTROLLED PENDING RESPONSE: never resolves on its own; rejects
      // fetch-shaped (AbortError) exactly when this request's abort signal
      // fires - the production deadline-abort path, deterministically.
      if (opts.markerPendingUntilAbort) {
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (opts.markerTimeoutFirstCall && dispatchIdx === 1) {
        // the FIRST markers request times out: the exact AbortError shape
        // an inner-controller timeout produces, with the outer run signal
        // still live - a retryable transport failure per the completion
        // contract (a real dispatch: it reached the wire and counts).
        // The retry re-dispatches with dispatchIdx 2 -> normal 200.
        const e = new Error('This operation was aborted (timeout)');
        e.name = 'AbortError';
        throw e;
      }
      if (opts.markerAttemptFailOnce && seen === 1) {
        return new Response('{"error":"transient 500"}', { status: 500 });
      }
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
      const attempt = (detailAttempts.get(station_id) ?? 0) + 1;
      detailAttempts.set(station_id, attempt);
      if (opts.detailAttemptFailOnce && attempt === 1) {
        return new Response('{"error":"transient 500"}', { status: 500 });
      }
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
    now: () => nowMs,
    sleepImpl: async (ms: number) => {
      nowMs += ms;
    },
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
const D500 = { label: 'Destination', lat: 500 / KM_PER_DEG, lon: 0 };

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
    const { client, calls } = wireStatiq(
      {
        specs: POOL,
        detailsBehavior: (_id, dispatch) =>
          dispatch <= 3
            ? null // first three lookups succeed
            : {
                status: 429,
                headers: { 'Retry-After': '30' },
                body: '{"error":"Please wait a minute."}',
              },
      },
      // Wide fake gaps (2s -> 10 poll chunks per waiter) give the 429's
      // stop (~4 microtask hops) a guaranteed margin, mirroring the proven
      // concurrent-throttle analysis in statiq-budget.test.ts; with 1ms
      // gaps a waiter could slip one extra dispatch before the stop lands
      { minCallGapMs: 2_000, maxCallsPerMinute: 10_000 },
    );
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
    expect(err.message).toContain(`after ${expectedMarkerCalls(700) + 4} of 800`);
  });

  it('attempt-cap exhaustion refuses the next dispatch before any traffic', async () => {
    // 60 marker samples + 3 successful lookups = exactly the cap: the 4th
    // lookup's RESERVATION is refused pre-dispatch (reservation-after-permit)
    // - honest budget-exhausted, with the aggregate evidence. The advisory
    // estimate line reports (~5 more calls) but NEVER gates: the owner
    // policy is every-candidate-checked and the run simply hits its cap.
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

  it('an EXACT-FIT budget covers the whole finite pool and plans', async () => {
    // cap = 60 samples + 8 candidates EXACTLY: every candidate is checked
    // with a single call and the plan succeeds - the every-candidate policy
    // runs to completion whenever the budget suffices
    const { client, calls } = wireStatiq({ specs: POOL });
    const plan = await planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
      {
        runBudget: {
          deadlineMs: 60_000,
          maxUpstreamCalls: expectedMarkerCalls(700) + 8,
        },
      },
    );
    expect(plan.stops.length).toBeGreaterThanOrEqual(1);
    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    expect(details).toHaveLength(8);
  });

  it('a deadline abort MID-SCAN fails as an honest not_determined:deadline', async () => {
    // FIXTURE REPAIR (Linux found the prior shape racing): it assumed
    // serialized dispatch (60 x 10ms = 600ms > 200ms), but the corridor
    // scans with FOUR concurrent workers - a 10ms transport latency lets
    // the whole 60-sample scan dispatch-and-complete well before a 200ms
    // deadline, so the plan could succeed instead of aborting.
    //
    // Repaired design - CONTROLLED PENDING RESPONSES + a CONCURRENCY-AWARE
    // BARRIER, no longer-deadline hack and no production change: marker
    // calls never complete on their own (they reject fetch-shaped exactly
    // when their abort signal fires). The barrier waits until all 4 scan
    // workers (the production scanCorridor concurrency) hold pending
    // requests; the abort then provably lands mid-scan with work in flight.
    const { client, calls } = wireStatiq({ specs: POOL, markerPendingUntilAbort: true });
    const planPromise = planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
      { runBudget: { deadlineMs: 100, maxUpstreamCalls: 1_000 } },
    ).catch((e) => e);
    // BARRIER: wait until all 4 corridor workers hold pending marker
    // requests (production scan concurrency = 4; no further dispatch is
    // possible while every worker is blocked). Real-timer polling here is
    // observation only - the dispatches themselves are fake-clock-paced
    // and fire within microseconds; the poll sees 4 within a few ticks.
    const barrierDeadline = Date.now() + 5_000;
    while (
      calls.filter((c) => c.endpoint === 'markers').length < 4 &&
      Date.now() < barrierDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // concurrency-aware gate: exactly the production worker count in
    // flight, and (unlike the old loose bounds) nothing more can dispatch
    expect(calls.filter((c) => c.endpoint === 'markers')).toHaveLength(4);

    const err = await planPromise;
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('deadline');
    expect(err.message).toContain('time budget');
    // the plan-first report carried the full 60-sample plan into evidence
    expect(err.message).toContain('of 60 planned');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // EXACT (deterministic, not bounded): the 4 worker-dispatched samples
    // were still pending when the abort fired; the details phase never
    // started
    expect(markers).toHaveLength(4);
    expect(details).toHaveLength(0);
  });

  it('a per-request timeout MID-SCAN is retried, never a cancellation: the run completes', async () => {
    // The FIRST markers request times out (the exact AbortError shape the
    // inner 10s controller produces, with the outer run signal still
    // LIVE). Per the completion contract (685e7b9) that is a RETRYABLE
    // TRANSPORT FAILURE: the client retries it, the timed-out attempt
    // counts as real dispatch work, and the run completes. Had the old
    // misclassification remained, the run would have aborted as a FALSE
    // deadline (zero details dispatched).
    const { client, calls } = wireStatiq({ specs: POOL, markerTimeoutFirstCall: true });
    const plan = await planTrip({ router: fakeRouter(700), statiq: client }, O, D700);
    expect(plan.status).toBe('ok');
    expect(plan.stops.length).toBeGreaterThanOrEqual(1);

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // EXACT counts: every sample once, plus ONE retry for the timed-out
    // first request (reserved == dispatched: the timeout attempt reached
    // the wire and counts as real work); every candidate checked.
    expect(markers).toHaveLength(expectedMarkerCalls(700) + 1);
    expect(details).toHaveLength(8);
  });

  it('retry-driven MID-SCAN exhaustion keeps progress and fails budget-exhausted', async () => {
    // 500 km plans 43 samples; every sample's FIRST transport call 500s and
    // the retry succeeds (2 attempts per sample), so attempts reach the cap
    // of 70 exactly at the 35th completed sample: exhaustion DURING the
    // scan (not covered by the plan-first pre-check, 43 <= 70) with the
    // incremental progress retained in the evidence.
    const { client, calls } = wireStatiq({ specs: POOL, markerAttemptFailOnce: true });
    const err = await planTrip(
      { router: fakeRouter(500), statiq: client },
      O,
      D500,
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 70 } },
    ).catch((e) => e);
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('budget-exhausted');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // 70 attempts all consumed by markers (2 per sample; deterministic),
    // nothing reached details
    expect(markers).toHaveLength(70);
    expect(details).toHaveLength(0);
    // progress retained: N complete pairs where 2N + S = 70 and S is the
    // count of in-flight first-500s whose retry was refused (S in {0,2,4}
    // across the 4 workers) - so N is 33-35; the PLANNED denominator is the
    // deterministic figure
    expect(err.message).toMatch(/route samples covered (3[3-5])\/\1 of 43 planned/);
    expect(err.message).toContain('budget of 70 upstream attempts');
  });

  it('retry-driven MID-DETAILS exhaustion keeps progress and fails budget-exhausted', async () => {
    // 700 km = 60 samples (first-try) + 8 candidates whose first lookup
    // 500s and the retry succeeds (2 attempts each): the post-scan
    // pre-check passes (60 + 8 = 68 <= 70), then attempts reach the cap of
    // 70 exactly at the 4th completed candidate + 2 in-flight 500s.
    const { client, calls } = wireStatiq({ specs: POOL, detailAttemptFailOnce: true });
    const err = await planTrip(
      { router: fakeRouter(700), statiq: client },
      O,
      D700,
      { runBudget: { deadlineMs: 60_000, maxUpstreamCalls: 70 } },
    ).catch((e) => e);
    expectPlanningError(err);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('budget-exhausted');

    const markers = calls.filter((c) => c.endpoint === 'markers');
    const details = calls.filter((c) => c.endpoint === 'details');
    // the scan completed (60 first-try calls); 70 - 60 = 10 detail
    // attempts: N complete candidate pairs (500+200) plus S in-flight
    // first-500s (S in {0,2,4} across the 4 workers, 2N + S = 10)
    expect(markers).toHaveLength(expectedMarkerCalls(700));
    expect(details).toHaveLength(10);
    // progress retained: N complete candidate pairs (500+200) plus S
    // in-flight first-500s (S in {0,2,4} across the 4 workers, 2N + S =
    // 10): processed/detailed land in 3-5; the planned denominator (8) is
    // the deterministic figure
    expect(err.message).toMatch(/candidates processed [3-5]\/8 \([3-5] detailed, [3-5] remaining\)/);
    // the ADVISORY estimate line reports the remainder (never gated)
    expect(err.message).toMatch(/rough estimate: ~\d more upstream calls remain/);
  });
});
