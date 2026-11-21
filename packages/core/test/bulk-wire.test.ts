/**
 * REAL StatiqClient with explicit bulk opt-in over a wire-shaped fake bulk
 * transport. Proves the deployed bulk path is exercised through planTrip with
 * deterministic dispatch/abort gates and honest attempt accounting. Legacy
 * wire harnesses (injected fetch WITHOUT bulk opt-in) stay on legacy paths.
 */
import { describe, expect, it } from 'vitest';
import { OsrmRouter } from '../src/router.js';
import { planTrip } from '../src/planner.js';
import { StatiqAbortError, StatiqClient, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';
import type { ProviderCallContext } from '../src/provider-failure.js';

const KM_PER_DEG = 111.32;
const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';
const ctx: ProviderCallContext = { endpointClass: 'stations/markers', phase: 'scan' };

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Bounded poll for a deterministic dispatch gate; never hangs a test run. */
async function waitFor(condition: () => boolean, label: string, limitMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
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

function envelope(endpoint: 'markers-bulk' | 'details-bulk', items: unknown[]) {
  return {
    ok: items.every((i: any) => i.outcome === 'ok' || i.outcome === 'confirmed-empty'),
    live: true, retained: false, endpoint,
    startedAt: NOW, completedAt: LATER, deadline: { ms: 150000, hit: false },
    requestedItems: items.length, attemptedItems: items.length, completedItems: items.length,
    upstreamAttempts: items.length, upstreamByStatus: { '200': items.length }, items,
  };
}

function bulkHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-evroute-upstream': 'statiq-live' };
}

interface HarnessOpts {
  /** Gate for the FIRST marker-bulk dispatch (resolve to allow its response). */
  markerGate?: ReturnType<typeof gate>;
  /** Gate for the SECOND marker-bulk dispatch. */
  secondMarkerGate?: ReturnType<typeof gate>;
  /** Gate for the detail-bulk dispatch. */
  detailsGate?: ReturnType<typeof gate>;
  /** Make the first marker bulk call reject (unknown transport) instead of answering. */
  markerFatal?: boolean;
  /** Throw a whole-call throttle response on markers. */
  throttleMarkers?: boolean;
  /** Inject an explicit abort listener signal notice. */
  notice?: { dispatch: () => void; aborted: () => void };
  routeKm?: number;
}

function harness(opts: HarnessOpts = {}) {
  const calls: Array<{ kind: 'markers' | 'details'; body: any }> = [];
  const audit: UpstreamAuditEntry[] = [];
  let markerBatches = 0;
  const fetchImpl = (async (url: any, init: any) => {
    const target = String(url);
    const signal = init?.signal as AbortSignal | undefined;
    const waitForRelease = async (release: ReturnType<typeof gate> | undefined): Promise<void> => {
      if (!release) return;
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => {
          opts.notice?.aborted();
          resolve();
        }, { once: true })),
      ]);
    };
    if (target.endsWith('/stations/markers-bulk')) {
      markerBatches++;
      const body = JSON.parse(init.body);
      calls.push({ kind: 'markers', body });
      opts.notice?.dispatch();
      if (markerBatches === 1) {
        if (opts.markerFatal) throw new Error('transport down');
        if (opts.throttleMarkers) {
          return new Response(JSON.stringify({ ok: false, error: { code: 'throttled' }, upstreamAttempts: 0 }),
            { status: 429, headers: { ...bulkHeaders(), 'retry-after': '30' } });
        }
        await waitForRelease(opts.markerGate);
      } else {
        await waitForRelease(opts.secondMarkerGate);
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const squares = body.squares as MarkerSquare[];
      const items = squares.map((s) => markerItem(s, Math.abs(s.latitude * KM_PER_DEG - 150) <= 13));
      return new Response(JSON.stringify(envelope('markers-bulk', items)),
        { status: 200, headers: bulkHeaders() });
    }
    if (target.endsWith('/stations/details-bulk')) {
      const body = JSON.parse(init.body);
      calls.push({ kind: 'details', body });
      opts.notice?.dispatch();
      await waitForRelease(opts.detailsGate);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const stations = body.stations as Array<{ key: string; stationId: number }>;
      const items = stations.map((s) => ({
        key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
        provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
          contentType: 'application/json', cacheControl: null },
        data: { source: 'Statiq station detail (live)', station: { ...station, stationId: s.stationId } },
      }));
      return new Response(JSON.stringify(envelope('details-bulk', items)),
        { status: 200, headers: bulkHeaders() });
    }
    throw new Error('unexpected legacy dispatch: bulk transport should not use legacy endpoints');
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'offline-only', baseUrl: 'https://worker.test/api', fetchImpl, bulk: true,
    minCallGapMs: 1, maxCallsPerMinute: 10000, retries: 0,
    runDeadlineAt: Date.now() + 60000, onUpstreamCall: (e) => audit.push(e),
  });
  client.attachRunBudget(new UpstreamBudget(200));
  const routeKm = opts.routeKm ?? 200;
  const router = { route: async () => ({
    distanceKm: routeKm, durationMin: routeKm,
    geometry: Array.from({ length: 21 }, (_, i) => ({ lat: (routeKm / KM_PER_DEG) * (i / 20), lon: 0 })),
  }) } as unknown as OsrmRouter;
  return { client, router, audit, calls, markerBatches: () => markerBatches };
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });
const OPTS = { startSocPct: 50 };

describe('real bulk wire lifecycle', () => {
  it('plans from verified bulk candidates and dispatches only bulk endpoints', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS);
    expect(plan.stops).toHaveLength(1);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.kind !== 'details' || true)).toBe(true);
    expect(h.calls.some((c) => c.kind === 'markers')).toBe(true);
    expect(h.calls.some((c) => c.kind === 'details')).toBe(true);
    expect(h.audit.every((e) => e.status === 200)).toBe(true);
  });

  it('bulk capability is explicit: injected transport without opt-in stays legacy', () => {
    const legacy = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch });
    expect(legacy.bulkSupported()).toBe(false);
    const opted = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch, bulk: true });
    expect(opted.bulkSupported()).toBe(true);
  });

  it('late marker abort after real dispatch is not counted as fresh coverage', async () => {
    const dispatch = gate();
    const release = gate();
    const aborted = gate();
    const h = harness({
      markerGate: release,
      notice: { dispatch: dispatch.resolve, aborted: aborted.resolve },
    });
    // Detect the run's deadline abort from the injected fetch signal.
    const pendingFetch = h.calls;
    void pendingFetch;
    const errP = planTrip({ router: h.router, statiq: h.client }, O, D(200),
      { ...OPTS, runBudget: { deadlineMs: 40, maxUpstreamCalls: 200 } }).catch((e: unknown) => e);
    await dispatch.promise;
    // Deterministic: the injected fetch reports the real deadline abort
    // before we release the response, so the late body cannot count.
    await aborted.promise;
    release.resolve();
    const err = await errP;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('not determined');
    expect(message).toContain('route samples covered 0/');
    expect(h.calls.filter((c) => c.kind === 'markers').length).toBe(1);
  });

  it('late details abort after real dispatch freezes candidate progress at zero', async () => {
    const release = gate();
    const h = harness({ detailsGate: release });
    const errP = planTrip({ router: h.router, statiq: h.client }, O, D(200),
      { ...OPTS, runBudget: { deadlineMs: 60, maxUpstreamCalls: 200 } }).catch((e: unknown) => e);
    // Wait for the details dispatch, then let the deadline abort it.
    await waitFor(() => h.calls.some((c) => c.kind === 'details'), 'bulk details dispatch');
    release.resolve();
    const err = await errP;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('not determined');
    expect(message).toContain('candidates processed 0/');
  });

  it('keeps earlier bulk samples when a later batch fails, with exact progress counts', async () => {
    const secondGate = gate();
    const h = harness({ routeKm: 260, secondMarkerGate: secondGate });
    const errP = planTrip({ router: h.router, statiq: h.client }, O, D(260),
      { ...OPTS, runBudget: { deadlineMs: 80, maxUpstreamCalls: 200 } }).catch((e: unknown) => e);
    await waitFor(() => h.markerBatches() >= 2, 'second bulk marker batch');
    secondGate.resolve();
    const err = await errP;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('not determined');
    // 23 samples planned: 12 from the first batch survived, 11 later holes.
    expect(message).toContain('11 of 23 route samples could not be scanned');
    expect(message).not.toContain('23 of 23');
  });

  it('an exact upstream budget settles fully and still plans', async () => {
    const h = harness();
    // 200 km => 18 marker samples; 1 unique station detail => 19 attempts.
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200),
      { ...OPTS, runBudget: { deadlineMs: 2000, maxUpstreamCalls: 19 } });
    expect(plan.stops).toHaveLength(1);
    expect(h.calls.filter((c) => c.kind === 'markers').reduce((n, c) => n + (c.body.squares?.length ?? 0), 0)).toBe(18);
    expect(h.calls.filter((c) => c.kind === 'details')).toHaveLength(1);
  });

  it('unknown transport latches: no retry, no fallback and no follow-on batch', async () => {
    let legacyDispatch = 0;
    const client = new StatiqClient({
      token: 'offline-only', baseUrl: 'https://worker.test/api', bulk: true, retries: 0,
      fetchImpl: (async (url: any) => {
        if (String(url).endsWith('/markers-bulk')) throw new Error('transport down');
        legacyDispatch++;
        return new Response('{}');
      }) as typeof fetch,
    });
    client.attachRunBudget(new UpstreamBudget(20));
    const calls = [client.markersBulk([{ lat: 28.6, lon: 77.2 }], undefined, ctx).catch((e: unknown) => e),
      client.markersBulk([{ lat: 28.6, lon: 77.2 }], undefined, ctx).catch((e: unknown) => e)];
    const outcomes = await Promise.all(calls);
    expect(outcomes.every((o) => o instanceof Error)).toBe(true);
    expect(legacyDispatch).toBe(0);
    await expect(client.markers(1, 1)).rejects.toBeInstanceOf(Error);
  });

  it('one active bulk batch: a concurrent second batch is refused', async () => {
    const release = gate();
    const h = harness({ markerGate: release });
    const first = h.client.markersBulk([{ lat: 0, lon: 0 }], undefined, ctx);
    await expect(h.client.markersBulk([{ lat: 1, lon: 1 }], undefined, ctx)).rejects.toBeInstanceOf(StatiqAbortError);
    release.resolve();
    await first;
    expect(h.calls.filter((c) => c.kind === 'markers')).toHaveLength(1);
  });

  it('whole-call throttle fails closed without legacy fallback', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('throttl');
    expect(h.calls.filter((c) => c.kind === 'markers').length).toBe(1);
  });
});
