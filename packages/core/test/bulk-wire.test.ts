/**
 * REAL StatiqClient with explicit bulk opt-in over a wire-shaped fake bulk
 * transport. Long client deadline (60s) satisfies the 25s minimum safe batch
 * lifecycle; cancellation is an EXPLICIT external AbortController fired AFTER
 * a real dispatch is observed. Every gate wait is bounded and cleaned up.
 */
import { describe, expect, it } from 'vitest';
import { OsrmRouter } from '../src/router.js';
import { planTrip } from '../src/planner.js';
import {
  StatiqAbortError, StatiqClient, StatiqRunFatalError,
  type UpstreamAuditEntry,
} from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';
import type { ProviderCallContext } from '../src/provider-failure.js';

const KM_PER_DEG = 111.32;
const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';
const ctx: ProviderCallContext = { endpointClass: 'stations/markers', phase: 'scan' };
const LONG_CLIENT_DEADLINE = 60_000;

interface Gate { promise: Promise<void>; resolve: () => void; }
function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** Every async gate wait is bounded; no test can hang forever. */
async function wait(promise: Promise<void>, label: string, limitMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), limitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const station = {
  stationId: 1, name: 'Fixture station', lat: 150 / KM_PER_DEG, lon: 0,
  address: null, area: null, city: null, landmark: null, hours: null, openText: null,
  rating: null, reviewCount: null, accessType: 'public', navUrl: '', stationUrl: '',
  imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: 11, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20,
    currency: 'INR', lastUsedOn: null,
    connectors: [{ displayId: 1, connectorId: 101, type: 'CCS-2', status: 'available',
      available: true, note: null }] }],
  summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: {} },
};
interface MarkerSquare { key: string; latitude: number; longitude: number; vertices: number[][] }

function markerItem(square: MarkerSquare, near: boolean) {
  const common = {
    key: square.key, latitude: square.latitude, longitude: square.longitude, vertices: square.vertices,
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json', cacheControl: null },
    reason: null,
  };
  if (!near) return { ...common, outcome: 'confirmed-empty', data: null,
    confirmation: { ...common.provenance, fetchedAt: LATER, statusCode: 1001,
      success: false, message: 'No stations found with selected filters', stationsCount: 0 } };
  return { ...common, outcome: 'ok', data: {
    source: 'Statiq station markers (live)', count: 1,
    stations: [{ stationId: 1, name: station.name, lat: station.lat, lon: station.lon,
      address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
  } };
}
function bulkEnvelope(endpoint: 'markers-bulk' | 'details-bulk', items: unknown[]) {
  return {
    ok: items.every((i: any) => i.outcome === 'ok' || i.outcome === 'confirmed-empty'),
    live: true, retained: false, endpoint,
    startedAt: NOW, completedAt: LATER, deadline: { ms: 150000, hit: false },
    requestedItems: items.length, attemptedItems: items.length, completedItems: items.length,
    upstreamAttempts: items.length, upstreamByStatus: { '200': items.length }, items,
  };
}
const BULK_HEADERS: Record<string, string> = {
  'content-type': 'application/json', 'cache-control': 'no-store',
  'x-evroute-upstream': 'statiq-live',
};

interface HarnessOpts {
  /** Dispatch gate for marker-bulk calls; index is 1-based batch number. */
  markerGates?: Gate[];
  /** Dispatch gate for details-bulk. */
  detailsGate?: Gate;
  /** Return a VALID (uncooperative) success after the gate even if aborted. */
  uncooperativeLateSuccess?: boolean;
  /** First marker call throws (unknown transport). */
  markerFatal?: boolean;
  /** Whole-call throttle response on markers. */
  throttleMarkers?: boolean;
  routeKm?: number;
}
interface Harness {
  client: StatiqClient;
  router: OsrmRouter;
  audit: UpstreamAuditEntry[];
  markerCalls: number;
  detailCalls: number;
  legacyCalls: number;
  markerSquares: number[];
  markerBatchCount: () => number;
}

function harness(opts: HarnessOpts = {}): Harness {
  const audit: UpstreamAuditEntry[] = [];
  let markerCalls = 0, detailCalls = 0, legacyCalls = 0, markerBatchNo = 0;
  const markerSquares: number[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const target = String(url);
    if (target.endsWith('/stations/markers-bulk')) {
      markerCalls++;
      markerBatchNo++;
      const body = JSON.parse(init.body);
      const squares = body.squares as MarkerSquare[];
      markerSquares.push(squares.length);
      const gateFor = opts.markerGates?.[Math.min(markerBatchNo, opts.markerGates.length) - 1];
      if (gateFor) await wait(gateFor.promise, `marker gate ${markerBatchNo}`);
      if (!opts.uncooperativeLateSuccess && init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (opts.markerFatal && markerBatchNo === 1) throw new Error('transport down');
      if (opts.throttleMarkers && markerBatchNo === 1) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'throttled' }, upstreamAttempts: 0 }),
          { status: 429, headers: { ...BULK_HEADERS, 'retry-after': '30' } });
      }
      const items = squares.map((s) => markerItem(s, Math.abs(s.latitude * KM_PER_DEG - 150) <= 13));
      return new Response(JSON.stringify(bulkEnvelope('markers-bulk', items)),
        { status: 200, headers: BULK_HEADERS });
    }
    if (target.endsWith('/stations/details-bulk')) {
      detailCalls++;
      const body = JSON.parse(init.body);
      if (opts.detailsGate) await wait(opts.detailsGate.promise, 'details gate');
      if (!opts.uncooperativeLateSuccess && init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const stations = body.stations as Array<{ key: string; stationId: number }>;
      const items = stations.map((s) => ({
        key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
        provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
          contentType: 'application/json', cacheControl: null },
        data: { source: 'Statiq station detail (live)', station: { ...station, stationId: s.stationId } },
      }));
      return new Response(JSON.stringify(bulkEnvelope('details-bulk', items)),
        { status: 200, headers: BULK_HEADERS });
    }
    legacyCalls++;
    return new Response(JSON.stringify({ ok: true, stations: [], count: 0 }));
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'offline-only', baseUrl: 'https://worker.test/api', fetchImpl, bulk: true,
    minCallGapMs: 1, maxCallsPerMinute: 10000, retries: 0,
    runDeadlineAt: Date.now() + LONG_CLIENT_DEADLINE,
    onUpstreamCall: (e) => audit.push(e),
  });
  client.attachRunBudget(new UpstreamBudget(200));
  const routeKm = opts.routeKm ?? 200;
  const router = { route: async () => ({
    distanceKm: routeKm, durationMin: routeKm,
    geometry: Array.from({ length: 21 }, (_, i) => ({ lat: (routeKm / KM_PER_DEG) * (i / 20), lon: 0 })),
  }) } as unknown as OsrmRouter;
  return { client, router, audit,
    get markerCalls() { return markerCalls; },
    get detailCalls() { return detailCalls; },
    get legacyCalls() { return legacyCalls; },
    markerSquares, markerBatchCount: () => markerBatchNo };
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });
const OPTS = { startSocPct: 50 };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('real bulk wire lifecycle', () => {
  it('plans from bulk candidates with honest dispatch counts', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS);
    expect(plan.stops).toHaveLength(1);
    expect(h.markerCalls).toBe(2); // 12 + 6 marker squares
    expect(h.detailCalls).toBe(1);
    expect(h.legacyCalls).toBe(0);
    expect(h.markerSquares).toEqual([12, 6]);
    expect(h.audit.length).toBe(19); // verified per-item upstream attempts
    expect(h.audit.every((e) => e.status === 200)).toBe(true);
  });

  it('capability is explicit: injected fetch without opt-in stays legacy', () => {
    const legacy = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch });
    expect(legacy.bulkSupported()).toBe(false);
    const opted = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch, bulk: true });
    expect(opted.bulkSupported()).toBe(true);
  });

  it('late UNCOOPERATIVE marker success after external abort is not audited or dispatched', async () => {
    const dispatch = gate(), release = gate();
    const h = harness({ markerGates: [release], uncooperativeLateSuccess: true });
    const outer = new AbortController();
    const pending = h.client.markersBulk(
      [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0 }], outer.signal, ctx);
    // Observe real dispatch before cancellation; bounded via client transport.
    await wait(Promise.resolve(), 'dispatch observation');
    expect(h.markerCalls).toBe(1);
    outer.abort();
    release.resolve();
    const outcome = await pending.catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(StatiqAbortError);
    expect(h.markerCalls).toBe(1);
    expect(h.audit).toHaveLength(0); // no stale success counted
  });

  it('late UNCOOPERATIVE details success after external abort leaves zero coverage', async () => {
    const release = gate();
    const h = harness({ detailsGate: release, uncooperativeLateSuccess: true });
    const outer = new AbortController();
    // One marker batch succeeds first; then the details call is held.
    const pending = h.client.detailsBulk([1], outer.signal,
      { endpointClass: 'stations/details', phase: 'details' });
    expect(h.detailCalls).toBe(1);
    outer.abort();
    release.resolve();
    const outcome = await pending.catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(StatiqAbortError);
    expect(h.detailCalls).toBe(1);
    expect(h.audit).toHaveLength(0);
  });

  it('later marker batch failure retains first-batch progress with honest counts', async () => {
    const second = gate();
    const h = harness({ routeKm: 260, markerGates: [undefined, second] as Gate[] });
    const errP = planTrip({ router: h.router, statiq: h.client }, O, D(260), OPTS).catch((e: unknown) => e);
    // Wait for the second real dispatch with bounded polling.
    const deadline = Date.now() + 2000;
    while (h.markerBatchCount() < 2 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    expect(h.markerBatchCount()).toBe(2);
    second.resolve();
    const message = messageOf(await errP);
    expect(message).toContain('not determined');
    expect(message).toContain('11 of 23 route samples could not be scanned');
    expect(message).not.toContain('23 of 23');
  });

  it('exact 19-attempt budget settles pessimism and still plans with 19 observed attempts', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200),
      { ...OPTS, runBudget: { deadlineMs: 120000, maxUpstreamCalls: 19 } });
    expect(plan.stops).toHaveLength(1);
    expect(h.audit.length).toBe(19);
    expect(h.markerSquares).toEqual([12, 6]);
    expect(h.detailCalls).toBe(1);
  });

  it('unknown transport latches: one dispatch, no retry/fallback/follow-on, full hold retained', async () => {
    const h = harness({ markerFatal: true });
    const budget = new UpstreamBudget(20);
    h.client.attachRunBudget(budget);
    const first = await h.client.markersBulk([{ lat: 28.6, lon: 77.2 }], undefined, ctx).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect(h.markerCalls).toBe(1);
    expect(budget.attemptsMade).toBe(1);
    const second = await h.client.markersBulk([{ lat: 28.7, lon: 77.3 }], undefined, ctx).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(Error);
    expect(h.markerCalls).toBe(1); // latched, no second dispatch
    expect(budget.attemptsMade).toBe(1);
    await expect(h.client.markers(1, 1)).rejects.toBeInstanceOf(Error);
    expect(h.legacyCalls).toBe(0);
  });

  it('single active batch: a concurrent second batch is refused after one dispatch', async () => {
    const release = gate();
    const h = harness({ markerGates: [release] });
    const first = h.client.markersBulk([{ lat: 0, lon: 0 }], undefined, ctx);
    await expect(h.client.markersBulk([{ lat: 1, lon: 1 }], undefined, ctx)).rejects.toBeInstanceOf(StatiqAbortError);
    release.resolve();
    await first;
    expect(h.markerCalls).toBe(1);
  });

  it('whole-call throttle fails closed without legacy fallback', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS).catch((e: unknown) => e);
    expect(messageOf(err)).toContain('throttl');
    expect(h.markerCalls).toBe(1);
    expect(h.legacyCalls).toBe(0);
  });
});
